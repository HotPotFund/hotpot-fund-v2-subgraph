/* eslint-disable prefer-const */
import {Address, BigDecimal, BigInt} from '@graphprotocol/graph-ts'
import {Position, Token} from "../generated/schema";

import {UniV3Factory} from "../generated/Controller/UniV3Factory";
import {UniV3Pool} from "../generated/Controller/UniV3Pool";
import {ERC20} from "../generated/Controller/ERC20";
import {ERC20SymbolBytes} from "../generated/Controller/ERC20SymbolBytes";
import {ERC20NameBytes} from "../generated/Controller/ERC20NameBytes";

export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';

export let ZERO_BI = BigInt.fromI32(0);
export let ONE_BI = BigInt.fromI32(1);
export let ZERO_BD = BigDecimal.fromString('0');
export let ONE_BD = BigDecimal.fromString('1');
export let BI_18 = BigInt.fromI32(18);

// export const WETH_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const WETH_ADDRESS = '0xc778417e063141139fce010982780140aa0cd5ab';//ropsten
export const UNI_V3_FACTORY_ADDRESS = '0x1f98431c8ad98523631ae4a59f267346ea31f984';

// const DAI_WETH_03_POOL = '0xc2e9f25be6257c210d7adf0d4cd6e3e881ba25f8'
// const USDC_WETH_03_POOL = '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8';
const USDC_WETH_03_POOL = '0x35a23a79310d3cabd81bdf0df75f39afb51560f5';//ropsten

// token where amounts should contribute to tracked volume and liquidity
export let STABLE_TOKENS: string[] = [
    // '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
    '0x46ea852f836fd93afdd80e8af2fcbd70b73044a6', // ropsten DAI
    // '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0x74945623f947b0a8764cd365d3a4784e7d91c8e4', // ropsten USDC
    // '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x1465fff54d9d746601845ca2762a0111671cc830', // ropsten USDT
    // '0x0000000000085d4780b73119b644ae5ecd22b376', // TUSD
    '0x722abbe70fb536d12e3506b6b062813f8b8b7b04', // ropsten sUSD
];

export let uniV3Factory = UniV3Factory.bind(Address.fromString(UNI_V3_FACTORY_ADDRESS));

export let FixedPoint_Q128_BD = BigInt.fromI32(2).pow(128).toBigDecimal();
export let FixedPoint_Q128_BI = BigInt.fromI32(2).pow(128);
export let FixedPoint_Q96_BD = BigInt.fromI32(2).pow(96).toBigDecimal();
export let FixedPoint_Q96_BI = BigInt.fromI32(2).pow(96);

function getEthPriceInUSD(): BigDecimal {
    // fetch eth prices for each stablecoin
    // dai is token0、usdc is token0、usdt is token1
    let usdcPool = UniV3Pool.bind(Address.fromString(USDC_WETH_03_POOL)); // usdc is token0
    let result = usdcPool.try_slot0();
    if (!result.reverted) {
        let sqrtPrice = (result.value.value0).toBigDecimal().div(FixedPoint_Q96_BD);
        return sqrtPrice.times(sqrtPrice);
    } else
        return ZERO_BD;
}

export function getTokenPriceUSD(tokenEntity: Token): BigDecimal {
    let ethUsdPrice = getEthPriceInUSD();
    if (tokenEntity.id == WETH_ADDRESS) return ethUsdPrice;

    let largestUSDLiquidity = ZERO_BD;
    let priceSoFar = ZERO_BD;
    let ethPoolAddr = uniV3Factory.getPool(Address.fromString(tokenEntity.id), Address.fromString(WETH_ADDRESS), 3000);
    if (ethPoolAddr.toHex() != ADDRESS_ZERO) {
        let weth9 = ERC20.bind(Address.fromString(WETH_ADDRESS));
        largestUSDLiquidity = convertTokenToDecimal(weth9.balanceOf(ethPoolAddr), BI_18).times(ethUsdPrice);

        let uniV3Pool = UniV3Pool.bind(ethPoolAddr);
        let sqrtPrice0: BigDecimal = ZERO_BD;
        let result = uniV3Pool.try_slot0();
        if (!result.reverted) sqrtPrice0 = (uniV3Pool.slot0().value0).toBigDecimal().div(FixedPoint_Q96_BD);
        let price0 = sqrtPrice0.times(sqrtPrice0);

        if (tokenEntity.id < WETH_ADDRESS) {
            priceSoFar = price0.times(ethUsdPrice);
        } else {
            priceSoFar = price0.notEqual(ZERO_BD) ? ONE_BD.div(price0).times(ethUsdPrice) : ZERO_BD;
        }
    }

    for (let i = 0; i < STABLE_TOKENS.length; i++) {
        if (tokenEntity.id == STABLE_TOKENS[i]) return ONE_BD;

        let poolAddress = uniV3Factory.getPool(Address.fromString(tokenEntity.id), Address.fromString(STABLE_TOKENS[i]), 3000);
        if (poolAddress.toHex() == ADDRESS_ZERO) continue;

        let uniV3Pool = UniV3Pool.bind(poolAddress);
        let sqrtPrice0: BigDecimal = ZERO_BD;
        let result = uniV3Pool.try_slot0();
        if (!result.reverted) sqrtPrice0 = (uniV3Pool.slot0().value0).toBigDecimal().div(FixedPoint_Q96_BD);
        let price0 = sqrtPrice0.times(sqrtPrice0);

        if (tokenEntity.id > STABLE_TOKENS[i]) price0 = price0.notEqual(ZERO_BD) ? ONE_BD.div(price0) : ZERO_BD;

        let stableCoin = ERC20.bind(Address.fromString(STABLE_TOKENS[i]));
        let liquidity = convertTokenToDecimal(stableCoin.balanceOf(poolAddress), BigInt.fromI32(stableCoin.decimals()));
        if (largestUSDLiquidity.lt(liquidity)) {
            largestUSDLiquidity = liquidity;
            priceSoFar = price0;
        }
    }

    return priceSoFar;
}

export function exponentToBigDecimal(decimals: BigInt): BigDecimal {
    let bd = BigDecimal.fromString('1');
    for (let i = ZERO_BI; i.lt(decimals as BigInt); i = i.plus(ONE_BI)) {
        bd = bd.times(BigDecimal.fromString('10'))
    }
    return bd;
}

export function convertTokenToDecimal(tokenAmount: BigInt, exchangeDecimals: BigInt): BigDecimal {
    if (exchangeDecimals == ZERO_BI) {
        return tokenAmount.toBigDecimal()
    }
    return tokenAmount.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals))
}

export function equalToZero(value: BigDecimal): boolean {
    const formattedVal = parseFloat(value.toString());
    const zero = parseFloat(ZERO_BD.toString());
    return zero == formattedVal;
}

export function isNullEthValue(value: string): boolean {
    return value == '0x0000000000000000000000000000000000000000000000000000000000000001'
}

export function fetchTokenSymbol(tokenAddress: Address): string {
    let contract = ERC20.bind(tokenAddress);
    let contractSymbolBytes = ERC20SymbolBytes.bind(tokenAddress);

    // try types string and bytes32 for symbol
    let symbolValue = 'unknown';
    let symbolResult = contract.try_symbol();
    if (symbolResult.reverted) {
        let symbolResultBytes = contractSymbolBytes.try_symbol();
        if (!symbolResultBytes.reverted) {
            // for broken pairs that have no symbol function exposed
            if (!isNullEthValue(symbolResultBytes.value.toHexString())) {
                symbolValue = symbolResultBytes.value.toString()
            }
        }
    } else {
        symbolValue = symbolResult.value
    }

    return symbolValue
}

export function fetchTokenName(tokenAddress: Address): string {
    let contract = ERC20.bind(tokenAddress);
    let contractNameBytes = ERC20NameBytes.bind(tokenAddress);

    // try types string and bytes32 for name
    let nameValue = 'unknown';
    let nameResult = contract.try_name();
    if (nameResult.reverted) {
        let nameResultBytes = contractNameBytes.try_name();
        if (!nameResultBytes.reverted) {
            // for broken exchanges that have no name function exposed
            if (!isNullEthValue(nameResultBytes.value.toHexString())) {
                nameValue = nameResultBytes.value.toString()
            }
        }
    } else {
        nameValue = nameResult.value
    }

    return nameValue
}

export function fetchTokenTotalSupply(tokenAddress: Address): BigInt {
    let contract = ERC20.bind(tokenAddress);
    let totalSupplyValue = 0;
    let totalSupplyResult = contract.try_totalSupply();
    if (!totalSupplyResult.reverted) {
        totalSupplyValue = totalSupplyResult as i32
    }
    return BigInt.fromI32(totalSupplyValue as i32)
}

export function fetchTokenDecimals(tokenAddress: Address): BigInt {
    let contract = ERC20.bind(tokenAddress);
    // try types uint8 for decimals
    let decimalValue = null;
    let decimalResult = contract.try_decimals();
    if (!decimalResult.reverted) {
        decimalValue = decimalResult.value
    }

    return BigInt.fromI32(decimalValue as i32)
}

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

export function getFeeGrowthInside(params: FeeGrowthInsideParams): FeeGrowthInsides {
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

export class CalFeesParams {
    tickCurrent: i32;
    feeGrowthGlobal0X128: BigInt;
    feeGrowthGlobal1X128: BigInt;
    fundTokenPriceUSD: BigDecimal;
    token0PriceUSD: BigDecimal;
    token1PriceUSD: BigDecimal;
    decimals0: BigInt;
    decimals1: BigInt;
}

export class FeesOfPosition {
    fees: BigDecimal;
    feeGrowthInside0X128: BigInt;
    feeGrowthInside1X128: BigInt;
}

export function calFeesOfPosition(params: CalFeesParams, position: Position, uniPool: UniV3Pool): FeesOfPosition {
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
    // let fees = params.fundTokenPriceUSD.gt(ZERO_BD) ? feesUSD.div(params.fundTokenPriceUSD) : ZERO_BD;
    return {fees: feesUSD, feeGrowthInside0X128, feeGrowthInside1X128}
}
