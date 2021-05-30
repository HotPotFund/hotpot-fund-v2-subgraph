import {BigDecimal, BigInt, Bytes, crypto, ethereum, log} from "@graphprotocol/graph-ts"

import {
    AddCall,
    ChangeVerifiedToken,
    Harvest,
    InitCall,
    MoveCall,
    SetPathCall,
    SubCall,
} from "../../generated/Controller/Controller";
import {ERC20} from "../../generated/Controller/ERC20";
import {UniV3Pool} from "../../generated/Controller/UniV3Pool";
import {
    AddTx,
    Fund,
    FundSummary,
    HarvestSummary,
    HarvestTx,
    InitTx, Manager,
    MoveTx,
    Path,
    Pool,
    Position,
    SetPathTx,
    SubTx,
    Token,
    Transaction
} from "../../generated/schema";
import {
    BI_18,
    convertTokenToDecimal,
    exponentToBigDecimal,
    fetchTokenDecimals,
    fetchTokenName,
    fetchTokenSymbol,
    fetchTokenTotalSupply, FixedPoint_Q128_BD, FixedPoint_Q128_BI,
    getTokenPriceUSD,
    ONE_BI,
    uniV3Factory,
    ZERO_BD,
    ZERO_BI
} from "../helpers";
import {Address, ByteArray} from "@graphprotocol/graph-ts/index";
import {Fund as FundContract} from "../../generated/templates/Fund/Fund";
import {updateFundDayData} from "./dayUpdates";


class FeeGrowthInsideParams {
    pool: UniV3Pool;
    tickLower: i32;
    tickUpper: i32;
    tickCurrent: i32;
    feeGrowthGlobal0X128: BigInt;
    feeGrowthGlobal1X128: BigInt;
}

class FeeGrowthInsides {
    feeGrowthInside0X128: BigInt;
    feeGrowthInside1X128: BigInt;
}

function getFeeGrowthInside(params: FeeGrowthInsideParams): FeeGrowthInsides {
    let feeGrowthInside0X128: BigInt;
    let feeGrowthInside1X128: BigInt;

    // calculate fee growth below
    let results = params.pool.ticks(params.tickLower);
    let lowerFeeGrowthOutside0X128 = results.value2;
    let lowerFeeGrowthOutside1X128 = results.value3;

    let feeGrowthBelow0X128: BigInt;
    let feeGrowthBelow1X128: BigInt;
    if (params.tickCurrent >= params.tickLower) {
        feeGrowthBelow0X128 = lowerFeeGrowthOutside0X128;
        feeGrowthBelow1X128 = lowerFeeGrowthOutside1X128;
    } else {
        feeGrowthBelow0X128 = params.feeGrowthGlobal0X128.minus(lowerFeeGrowthOutside0X128);
        feeGrowthBelow1X128 = params.feeGrowthGlobal1X128.minus(lowerFeeGrowthOutside1X128);
    }

    // calculate fee growth above
    results = params.pool.ticks(params.tickUpper);
    let upperFeeGrowthOutside0X128 = results.value2;
    let upperFeeGrowthOutside1X128 = results.value3;

    let feeGrowthAbove0X128: BigInt;
    let feeGrowthAbove1X128: BigInt;
    if (params.tickCurrent < params.tickUpper) {
        feeGrowthAbove0X128 = upperFeeGrowthOutside0X128;
        feeGrowthAbove1X128 = upperFeeGrowthOutside1X128;
    } else {
        feeGrowthAbove0X128 = params.feeGrowthGlobal0X128.minus(upperFeeGrowthOutside0X128);
        feeGrowthAbove1X128 = params.feeGrowthGlobal1X128.minus(upperFeeGrowthOutside1X128);
    }

    feeGrowthInside0X128 = params.feeGrowthGlobal0X128.minus(feeGrowthBelow0X128).minus(feeGrowthAbove0X128);
    feeGrowthInside1X128 = params.feeGrowthGlobal1X128.minus(feeGrowthBelow1X128).minus(feeGrowthAbove1X128);

    return {feeGrowthInside0X128, feeGrowthInside1X128} as FeeGrowthInsides;
}

class CalFeesParams {
    tickCurrent: i32;
    feeGrowthGlobal0X128: BigInt;
    feeGrowthGlobal1X128: BigInt;
    fundTokenPriceUSD: BigDecimal;
    token0PriceUSD: BigDecimal;
    token1PriceUSD: BigDecimal;
    decimals0: BigInt;
    decimals1: BigInt;
}
class FeesOfPosition{
    fees: BigDecimal;
    feeGrowthInside0X128: BigInt;
    feeGrowthInside1X128: BigInt;
}

function calFeesOfPosition(params: CalFeesParams, position: Position, uniPool: UniV3Pool): FeesOfPosition {
    // get global feeGrowthInside
    let feeGrowthInside = getFeeGrowthInside({
        pool: uniPool,
        tickLower: position.tickLower.toI32(),
        tickUpper: position.tickUpper.toI32(),
        tickCurrent: params.tickCurrent,
        feeGrowthGlobal0X128: params.feeGrowthGlobal0X128,
        feeGrowthGlobal1X128: params.feeGrowthGlobal1X128
    });
    let feeGrowthInside0X128 = feeGrowthInside.feeGrowthInside0X128;
    let feeGrowthInside1X128 = feeGrowthInside.feeGrowthInside1X128;

    // calculate accumulated fees
    let amount0 = convertTokenToDecimal((feeGrowthInside0X128.minus(position.feeGrowthInside0LastX128)).times(position.liquidity).div(FixedPoint_Q128_BI), params.decimals0);
    let amount1 = convertTokenToDecimal((feeGrowthInside1X128.minus(position.feeGrowthInside1LastX128)).times(position.liquidity).div(FixedPoint_Q128_BI), params.decimals1);

    let feesUSD = amount0.times(params.token0PriceUSD).plus(amount1.times(params.token1PriceUSD));
    let fees = params.fundTokenPriceUSD.gt(ZERO_BD) ? feesUSD.div(params.fundTokenPriceUSD) : ZERO_BD;
    return {fees, feeGrowthInside0X128, feeGrowthInside1X128}
}

export function updateFundPools(fundEntity: Fund,
                                fundTokenEntity: Token,
                                fund: FundContract): BigDecimal {
    let deltaFees = ZERO_BD;
    for (let poolIndex = 0; poolIndex < fundEntity.poolsLength.toI32(); poolIndex++) {
        let pool = Pool.load(fundEntity.id + "-" + poolIndex.toString()) as Pool;
        let uniV3Pool = UniV3Pool.bind(Address.fromString(pool.address.toHex()));
        let token0Entity = Token.load(pool.token0) as Token;
        let token1Entity = Token.load(pool.token1) as Token;
        let fundTokenPriceUSD = getTokenPriceUSD(fundTokenEntity);
        let params: CalFeesParams = {
            tickCurrent: uniV3Pool.slot0().value1,
            feeGrowthGlobal0X128: uniV3Pool.feeGrowthGlobal0X128(),
            feeGrowthGlobal1X128: uniV3Pool.feeGrowthGlobal1X128(),
            fundTokenPriceUSD,
            token0PriceUSD: ZERO_BD,
            token1PriceUSD: ZERO_BD,
            decimals0: token0Entity.decimals,
            decimals1: token0Entity.decimals,
        };
        if (fundTokenEntity.id == token0Entity.id)
            params.token0PriceUSD = params.fundTokenPriceUSD;
        else
            params.token0PriceUSD = getTokenPriceUSD(token0Entity);

        if (fundTokenEntity.id == token1Entity.id)
            params.token1PriceUSD = params.fundTokenPriceUSD;
        else
            params.token1PriceUSD = getTokenPriceUSD(token1Entity);

        for (let positionIndex = 0; positionIndex < pool.positionsLength.toI32(); positionIndex++) {
            let position = Position.load(fundEntity.id + "-" + poolIndex.toString() + "-" + positionIndex.toString()) as Position;
            let results = calFeesOfPosition(params, position, uniV3Pool);
            deltaFees = deltaFees.plus(results.fees);
            position.liquidity = uniV3Pool.positions(position.positionKey).value0;
            position.isEmpty = !position.liquidity.gt(ZERO_BI);
            position.feeGrowthInside0LastX128 = results.feeGrowthInside0X128;
            position.feeGrowthInside1LastX128 = results.feeGrowthInside1X128;
            position.assetAmount = convertTokenToDecimal(fund.assetsOfPosition(BigInt.fromI32(poolIndex), BigInt.fromI32(positionIndex)), fundTokenEntity.decimals);
            position.assetAmountUSD = position.assetAmount.times(fundTokenPriceUSD);
            position.assetShare = fundEntity.totalAssets.gt(ZERO_BD) ? position.assetAmount.div(fundEntity.totalAssets) : ZERO_BD;
            position.save();
        }

        pool.assetAmount = convertTokenToDecimal(fund.assetsOfPool(BigInt.fromI32(poolIndex)), fundTokenEntity.decimals);
        pool.assetAmountUSD = pool.assetAmount.times(fundTokenPriceUSD);
        pool.assetShare = fundEntity.totalAssets.gt(ZERO_BD) ? pool.assetAmount.div(fundEntity.totalAssets) : ZERO_BD;
        pool.save();
    }

    return deltaFees;
}

export function syncFundStatusData(fundEntity: Fund,
                                   fundTokenEntity: Token,
                                   fund: FundContract,
                                   fundTokenPriceUSD: BigDecimal = null): void {
    fundEntity.balance = convertTokenToDecimal(ERC20.bind(Address.fromString(fundEntity.fundToken)).balanceOf(fund._address), fundTokenEntity.decimals);
    fundEntity.totalAssets = convertTokenToDecimal(fund.totalAssets(), fundTokenEntity.decimals);
    if (fundTokenPriceUSD != null) {//提升性能
        fundEntity.totalAssetsUSD = fundTokenPriceUSD.times(fundEntity.totalAssets);
    } else {
        fundEntity.totalAssetsUSD = getTokenPriceUSD(fundTokenEntity).times(fundEntity.totalAssets);
    }
}

export function syncTxStatusData(txEntity: Transaction, call: ethereum.Call): void {
    txEntity.timestamp = call.block.timestamp;
    txEntity.blockNumber = call.block.number;
    txEntity.from = call.transaction.from;
    txEntity.gasPrice = call.transaction.gasPrice.divDecimal(exponentToBigDecimal(BI_18));
    txEntity.gasUsed = call.transaction.gasUsed;
    txEntity.gasFee = txEntity.gasPrice.times(txEntity.gasUsed.toBigDecimal());
}

export function syncTxStatusDataWithEvent(txEntity: Transaction, event: ethereum.Event): void {
    txEntity.timestamp = event.block.timestamp;
    txEntity.blockNumber = event.block.number;
    txEntity.from = event.transaction.from;
    txEntity.gasPrice = event.transaction.gasPrice.divDecimal(exponentToBigDecimal(BI_18));
    txEntity.gasUsed = event.transaction.gasUsed;
    txEntity.gasFee = txEntity.gasPrice.times(txEntity.gasUsed.toBigDecimal());
}


//这个应该是第一个会调用的方法，因为要添加Token才能使用
export function handleChangeVerifiedToken(event: ChangeVerifiedToken): void {
    let address = event.params.token;
    let token = Token.load(address.toHex());

    if (token === null) {
        token = new Token(address.toHex());
        token.symbol = fetchTokenSymbol(address);
        token.name = fetchTokenName(address);
        token.totalSupply = fetchTokenTotalSupply(address);
        let decimals = fetchTokenDecimals(address);
        // bail if we couldn't figure out the decimals
        if (decimals === null) {
            log.debug('mybug the decimal on token 0 was null', []);
            decimals = BI_18;//默认设为18位精度
        }
        token.decimals = decimals;
    }
    token.isVerified = event.params.isVerified;

    token.save();
}

export function handleHarvest(event: Harvest): void {
    let txId = event.transaction.hash.toHex();
    let transaction = Transaction.load(txId) || new Transaction(txId);
    let id = txId + "-" + BigInt.fromI32(transaction.harvests.length).toString();
    transaction.harvests = transaction.harvests.concat([id]);
    syncTxStatusDataWithEvent(transaction as Transaction, event as ethereum.Event);

    let tokenEntity = Token.load(event.params.token.toHex()) as Token;
    if (tokenEntity === null) {
        tokenEntity = new Token(event.params.token.toHex());
        tokenEntity.symbol = fetchTokenSymbol(event.params.token);
        tokenEntity.name = fetchTokenName(event.params.token);
        tokenEntity.totalSupply = fetchTokenTotalSupply(event.params.token);
        tokenEntity.isVerified = false;
        let decimals = fetchTokenDecimals(event.params.token);
        // bail if we couldn't figure out the decimals
        if (decimals === null) {
            log.debug('mybug the decimal on token 0 was null', []);
            decimals = BI_18;//默认设为18位精度
        }
        tokenEntity.decimals = decimals;
        tokenEntity.save();
    }

    let havestTx = HarvestTx.load(id) || new HarvestTx(id);
    havestTx.transaction = txId;
    havestTx.token = tokenEntity.id;
    havestTx.amount = convertTokenToDecimal(event.params.amount, tokenEntity.decimals);
    havestTx.burned = convertTokenToDecimal(event.params.burned, BI_18);
    havestTx.amountUSD = getTokenPriceUSD(tokenEntity).times(havestTx.amount);

    let harvestSummary = HarvestSummary.load("1");
    if (harvestSummary === null) {
        harvestSummary = new HarvestSummary("1");
        harvestSummary.txCount = ONE_BI;
        harvestSummary.totalBurned = ZERO_BD;
        harvestSummary.totalAmountUSD = ZERO_BD;
    }
    harvestSummary.txCount = harvestSummary.txCount.plus(ONE_BI);
    harvestSummary.totalBurned = harvestSummary.totalBurned.plus(havestTx.burned);
    harvestSummary.totalAmountUSD = harvestSummary.totalAmountUSD.plus(havestTx.amountUSD);

    havestTx.save();
    transaction.save();
    harvestSummary.save();
}

export function handleSetPath(call: SetPathCall): void {
    let txId = call.transaction.hash.toHex();
    let transaction = Transaction.load(txId) || new Transaction(txId);
    let id = txId + "-" + BigInt.fromI32(transaction.setPaths.length).toString();
    transaction.setPaths = transaction.setPaths.concat([id]);
    transaction.fund = call.inputs.fund.toHex();
    syncTxStatusData(transaction as Transaction, call);

    let setPathTx = new SetPathTx(id);
    setPathTx.transaction = txId;
    setPathTx.fund = call.inputs.fund.toHex();
    setPathTx.distToken = call.inputs.distToken.toHex();
    setPathTx.buy = call.inputs.buy;
    setPathTx.path = call.inputs.path;

    let pathId = call.inputs.fund.toHex() + "-" + call.inputs.distToken.toHex() + "-" + (call.inputs.buy ? "1" : "0");
    let path = Path.load(pathId);
    if (path === null) {
        path = new Path(pathId);
        path.fund = setPathTx.fund;
        path.distToken = setPathTx.distToken;
        path.isBuy = setPathTx.buy;
    }
    setPathTx.save();

    path.path = setPathTx.path;
    transaction.save();
    path.save();
}

function updateFees(block: ethereum.Block,
                    fundEntity: Fund,
                    fundTokenEntity: Token,
                    fund: FundContract,
                    fundTokenPriceUSD: BigDecimal = null): void {
    syncFundStatusData(fundEntity, fundTokenEntity, fund, fundTokenPriceUSD);
    let fundSummary = FundSummary.load("1") as FundSummary;
    let manager = Manager.load(fundEntity.manager) as Manager;

    let deltaFees = updateFundPools(fundEntity, fundTokenEntity, fund);
    let totalShare = convertTokenToDecimal(fundEntity.totalSupply, fundEntity.decimals);
    let sharePrice = totalShare.gt(ZERO_BD) ? deltaFees.div(totalShare) : ZERO_BD;

    fundEntity.lastedSettlementPrice = fundEntity.lastedSettlementPrice.plus(sharePrice);
    fundEntity.totalFees = fundEntity.totalFees.plus(deltaFees);
    fundEntity.totalPendingFees = fundEntity.totalPendingFees.plus(deltaFees);
    fundSummary.totalFees = fundSummary.totalFees.plus(deltaFees);
    fundSummary.totalPendingFees = fundSummary.totalPendingFees.plus(deltaFees);
    manager.totalFees = manager.totalFees.plus(deltaFees);
    manager.totalPendingFees = manager.totalPendingFees.plus(deltaFees);
    updateFundDayData(block, fundEntity, totalShare);

    fundSummary.save();
    manager.save();
}

export function handleInit(call: InitCall): void {
    let fundEntity = Fund.load(call.inputs.fund.toHex()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(call.inputs.fund);
    let fundTokenPriceUSD = getTokenPriceUSD(fundTokenEntity);

    let txId = call.transaction.hash.toHex();
    let transaction = Transaction.load(txId) || new Transaction(txId);
    let id = txId + "-" + BigInt.fromI32(transaction.inits.length).toString();
    transaction.inits = transaction.inits.concat([id]);
    transaction.fund = call.inputs.fund.toHex();
    syncTxStatusData(transaction as Transaction, call);

    let initTx = new InitTx(id);
    initTx.transaction = txId;
    initTx.fund = call.inputs.fund.toHex();
    initTx.token0 = call.inputs.token0.toHex();
    initTx.token1 = call.inputs.token1.toHex();
    initTx.fee = BigInt.fromI32(call.inputs.fee);
    initTx.tickLower = BigInt.fromI32(call.inputs.tickLower);
    initTx.tickUpper = BigInt.fromI32(call.inputs.tickUpper);
    initTx.amount = convertTokenToDecimal(call.inputs.amount, fundTokenEntity.decimals);
    initTx.amountUSD = fundTokenPriceUSD.times(initTx.amount);

    //先计算fees
    updateFees(call.block, fundEntity, fundTokenEntity, fund, fundTokenPriceUSD);

    let poolAddress = uniV3Factory.getPool(call.inputs.token0, call.inputs.token1, call.inputs.fee);
    let fundPoolsLength = fund.poolsLength();//实际长度
    let poolIndex = fundEntity.poolsLength.toI32();//lasted的长度
    let pool: Pool;
    //new pool
    if (fundPoolsLength.gt(fundEntity.poolsLength)) {
        pool = new Pool(call.inputs.fund.toHex() + '-' + poolIndex.toString());
        pool.fund = initTx.fund;
        pool.address = poolAddress;
        pool.token0 = initTx.token0;
        pool.token1 = initTx.token1;
        pool.fee = initTx.fee;
        pool.positionsLength = ZERO_BI;
    }
    //old pool
    else {
        while (true) {
            poolIndex--;
            pool = Pool.load(call.inputs.fund.toHex() + '-' + poolIndex.toString()) as Pool;
            if (pool != null || poolIndex == 0) break;
        }
    }
    fundEntity.poolsLength = fundPoolsLength;
    pool.positionsLength = pool.positionsLength.plus(ONE_BI);
    pool.assetAmount = convertTokenToDecimal(fund.assetsOfPool(BigInt.fromI32(poolIndex)), fundTokenEntity.decimals);
    pool.assetShare = fundEntity.totalAssets.gt(ZERO_BD) ? pool.assetAmount.div(fundEntity.totalAssets) : ZERO_BD;
    pool.assetAmountUSD = fundTokenPriceUSD.times(pool.assetAmount);

    let uniV3Pool = UniV3Pool.bind(poolAddress);
    let positionIndex = pool.positionsLength.minus(ONE_BI);
    let position = new Position(call.inputs.fund.toHex() + '-' + poolIndex.toString() + '-' + positionIndex.toString());
    initTx.position = position.id;
    position.pool = pool.id;
    position.fund = fundEntity.id;
    position.isEmpty = !initTx.amount.notEqual(ZERO_BD);
    position.tickLower = initTx.tickLower;
    position.tickUpper = initTx.tickUpper;
    position.feeGrowthInside0LastX128 = uniV3Pool.feeGrowthGlobal0X128();
    position.feeGrowthInside1LastX128 = uniV3Pool.feeGrowthGlobal1X128();
    let keyEncoded = fundEntity.id
        + initTx.tickLower.toHex().substr(2).padStart(6, "0")
        + initTx.tickUpper.toHex().substr(2).padStart(6, "0");
    position.positionKey = Bytes.fromHexString(crypto.keccak256(ByteArray.fromHexString(keyEncoded)).toHex()) as Bytes;
    position.liquidity = uniV3Pool.positions(position.positionKey).value0;
    // position.liquidity = ZERO_BI;
    position.assetAmount = convertTokenToDecimal(fund.assetsOfPosition(BigInt.fromI32(poolIndex), positionIndex), fundTokenEntity.decimals);
    position.assetAmountUSD = fundTokenPriceUSD.times(pool.assetAmount);
    position.assetShare = fundEntity.totalAssets.gt(ZERO_BD) ? position.assetAmount.div(fundEntity.totalAssets) : ZERO_BD;

    initTx.save();
    transaction.save();
    pool.save();
    position.save();
    fundEntity.save();
}

export function handleAdd(call: AddCall): void {
    let fundEntity = Fund.load(call.inputs.fund.toHexString()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(call.inputs.fund);

    let txId = call.transaction.hash.toHex();
    let transaction = Transaction.load(txId) || new Transaction(txId);
    let id = txId + "-" + BigInt.fromI32(transaction.adds.length).toString();
    transaction.adds = transaction.adds.concat([id]);
    transaction.fund = call.inputs.fund.toHex();
    syncTxStatusData(transaction as Transaction, call);

    let addTx = AddTx.load(id) || new AddTx(id);
    addTx.transaction = txId;
    addTx.fund = call.inputs.fund.toHex();
    addTx.poolIndex = call.inputs.poolIndex;
    addTx.positionIndex = call.inputs.positionIndex;
    addTx.amount = convertTokenToDecimal(call.inputs.amount, fundTokenEntity.decimals);
    addTx.amountUSD = addTx.amount.times(getTokenPriceUSD(fundTokenEntity));
    addTx.collect = call.inputs.collect;
    addTx.position = call.inputs.fund.toHex() + "-" + addTx.poolIndex.toString() + "-" + addTx.positionIndex.toString();

    updateFees(call.block, fundEntity, fundTokenEntity, fund);

    addTx.save();
    transaction.save();
    fundEntity.save();
}

export function handleSub(call: SubCall): void {
    let fundEntity = Fund.load(call.inputs.fund.toHexString()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(call.inputs.fund);

    let txId = call.transaction.hash.toHex();
    let transaction = Transaction.load(txId) || new Transaction(txId);
    let id = txId + "-" + BigInt.fromI32(transaction.subs.length).toString();
    transaction.subs = transaction.subs.concat([id]);
    transaction.fund = call.inputs.fund.toHex();
    syncTxStatusData(transaction as Transaction, call);

    let subTx = SubTx.load(id) || new SubTx(id);
    subTx.transaction = txId;
    subTx.fund = call.inputs.fund.toHex();
    subTx.poolIndex = call.inputs.poolIndex;
    subTx.positionIndex = call.inputs.positionIndex;
    subTx.proportion = call.inputs.proportionX128.toBigDecimal().div(FixedPoint_Q128_BD);
    subTx.position = call.inputs.fund.toHex() + "-" + subTx.poolIndex.toString() + "-" + subTx.positionIndex.toString();

    updateFees(call.block, fundEntity, fundTokenEntity, fund);

    subTx.save();
    transaction.save();
    fundEntity.save();
}

export function handleMove(call: MoveCall): void {
    let fundEntity = Fund.load(call.inputs.fund.toHexString()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(call.inputs.fund);

    let txId = call.transaction.hash.toHex();
    let transaction = Transaction.load(txId) || new Transaction(txId);
    let id = txId + "-" + BigInt.fromI32(transaction.moves.length).toString();
    transaction.moves = transaction.moves.concat([id]);
    transaction.fund = call.inputs.fund.toHex();
    syncTxStatusData(transaction as Transaction, call);

    let movesTx = MoveTx.load(id) || new MoveTx(id);
    movesTx.transaction = txId;
    movesTx.fund = call.inputs.fund.toHexString();
    movesTx.poolIndex = call.inputs.poolIndex;
    movesTx.subIndex = call.inputs.subIndex;
    movesTx.addIndex = call.inputs.addIndex;
    movesTx.proportion = call.inputs.proportionX128.toBigDecimal().div(FixedPoint_Q128_BD);
    movesTx.subPosition = call.inputs.fund.toHex() + "-" + movesTx.poolIndex.toString() + "-" + movesTx.subIndex.toString();
    movesTx.addPosition = call.inputs.fund.toHex() + "-" + movesTx.poolIndex.toString() + "-" + movesTx.addIndex.toString();
    movesTx.amount = (Position.load(movesTx.subPosition) as Position)
        .assetAmount.minus(convertTokenToDecimal(fund.assetsOfPosition(movesTx.poolIndex, movesTx.subIndex), fundTokenEntity.decimals));
    movesTx.amountUSD = getTokenPriceUSD(fundTokenEntity).times(movesTx.amount);

    updateFees(call.block, fundEntity, fundTokenEntity, fund);

    movesTx.save();
    transaction.save();
    fundEntity.save();
}

export function handleBlock(block: ethereum.Block): void {
    //modDay在整点的-+24秒内，就认为是整点，相反就不是整点时刻
    //如果不是整点: modDay in (24 - 86376)
    let modDay = block.timestamp.mod(BigInt.fromI32(86400));
    if(modDay.gt(BigInt.fromI32(24)) && modDay.lt(BigInt.fromI32(86376))){
        //old data 60*60s处理一次  12h=2880block
        if (block.number.lt(BigInt.fromI32(10336624)) && block.number.mod(BigInt.fromI32(60 * 4))
            .notEqual(ZERO_BI)) return;

        //For performance, every 4*4 blocks are processed for about 4*60s
        if (block.number.mod(BigInt.fromI32(4 * 4)).notEqual(ZERO_BI)) return;
    }

    let fundSummary = FundSummary.load("1");
    if (fundSummary == null) return;
    let funds = fundSummary.funds as Array<string>;

    let totalAssetsUSD = ZERO_BD;
    for (let i = 0; i < funds.length; i++) {
        let fundEntity = Fund.load(funds[i]) as Fund;
        let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
        let fund = FundContract.bind(Address.fromString(funds[i]));
        let manager = Manager.load(fundEntity.manager) as Manager;

        syncFundStatusData(fundEntity, fundTokenEntity, fund);
        let deltaFees = updateFundPools(fundEntity, fundTokenEntity, fund);
        let totalShare = convertTokenToDecimal(fundEntity.totalSupply, fundEntity.decimals);
        let sharePrice = totalShare.gt(ZERO_BD) ? deltaFees.div(totalShare) : ZERO_BD;
        fundEntity.lastedSettlementPrice = fundEntity.lastedSettlementPrice.plus(sharePrice);
        fundEntity.totalFees = fundEntity.totalFees.plus(deltaFees);
        fundEntity.totalPendingFees = fundEntity.totalPendingFees.plus(deltaFees);
        fundSummary.totalFees = fundSummary.totalFees.plus(deltaFees);
        fundSummary.totalPendingFees = fundSummary.totalPendingFees.plus(deltaFees);
        manager.totalFees = manager.totalFees.plus(deltaFees);
        manager.totalPendingFees = manager.totalPendingFees.plus(deltaFees);
        updateFundDayData(block, fundEntity, totalShare);

        totalAssetsUSD = totalAssetsUSD.plus(fundEntity.totalAssetsUSD);
        manager.save();
        fundEntity.save();
    }
    fundSummary.totalAssetsUSD = totalAssetsUSD;
    fundSummary.save();
}
