import {
    DepositTx,
    Fund,
    FundSummary,
    Investor,
    InvestorSummary,
    Manager,
    Token,
    Transaction,
    WithdrawTx
} from "../../generated/schema";
import {Address, BigInt, ethereum} from "@graphprotocol/graph-ts/index";
import {
    Deposit as DepositEvent,
    Fund as FundContract,
    Transfer,
    Withdraw as WithdrawEvent
} from "../../generated/templates/Fund/Fund";
import {syncFundStatusData, syncTxStatusDataWithEvent, updateFundPools} from "./controller";
import {updateFundDayData, updateInvestorDayData} from "./dayUpdates";
import {ADDRESS_ZERO, convertTokenToDecimal, getTokenPriceUSD, ZERO_BD, ZERO_BI} from "../helpers";


export function handleTransfer(event: Transfer): void {
    if (event.params.from.toHexString() == ADDRESS_ZERO || event.params.to.toHexString() == ADDRESS_ZERO) return;

    let fundEntity = Fund.load(event.address.toHex()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(event.address);

    let deltaFees = updateFundPools(fundEntity, fundTokenEntity, fund);
    let totalShare = convertTokenToDecimal(fundEntity.totalSupply, fundEntity.decimals);
    let sharePrice = totalShare.gt(ZERO_BD) ? deltaFees.div(totalShare) : ZERO_BD;
    let lastedSettlementPrice = fundEntity.lastedSettlementPrice.plus(sharePrice);

    //结算fromInvestor
    let fromInvestor = createInvestorEntity(event.address, event.params.from);
    let fromInvestorLastedShare = convertTokenToDecimal(fromInvestor.share, fundEntity.decimals);
    let withdrewShare = convertTokenToDecimal(event.params.value, fundEntity.decimals);
    let fromInvestorFees = lastedSettlementPrice.minus(fromInvestor.lastedSettlementPrice).times(fromInvestorLastedShare);
    let withdrawFees = lastedSettlementPrice.minus(fromInvestor.lastedSettlementPrice).times(withdrewShare)
        .plus(fromInvestorLastedShare.gt(ZERO_BD) ? fromInvestor.totalPendingFees.times(withdrewShare).div(fromInvestorLastedShare) : ZERO_BD);
    fromInvestor.lastedSettlementPrice = lastedSettlementPrice;
    fromInvestor.totalFees = fromInvestor.totalFees.plus(fromInvestorFees);
    fromInvestor.totalPendingFees = fromInvestor.totalPendingFees.plus(fromInvestorFees).minus(withdrawFees);
    fromInvestor.totalWithdrewFees = fromInvestor.totalFees.minus(fromInvestor.totalPendingFees);

    fromInvestor.share = fromInvestor.share.minus(event.params.value);
    // @ts-ignore
    updateInvestorDayData(event as DepositEvent, fromInvestor, fromInvestorLastedShare);

    //结算toInvestor
    let toInvestor = createInvestorEntity(event.address, event.params.to);
    let toInvestorLastedShare = convertTokenToDecimal(toInvestor.share, fundEntity.decimals);
    let toInvestorFees = lastedSettlementPrice.minus(toInvestor.lastedSettlementPrice).times(toInvestorLastedShare);
    toInvestor.lastedSettlementPrice = lastedSettlementPrice;
    toInvestor.totalFees = fromInvestor.totalFees.plus(toInvestorFees);
    toInvestor.totalPendingFees = fromInvestor.totalPendingFees.plus(toInvestorFees);

    toInvestor.share = fromInvestor.share.plus(event.params.value);
    // @ts-ignore
    updateInvestorDayData(event as DepositEvent, toInvestor, toInvestorLastedShare);

    fundEntity.lastedSettlementPrice = lastedSettlementPrice;
    fundEntity.totalFees = fundEntity.totalFees.plus(deltaFees);
    fundEntity.totalPendingFees = fundEntity.totalPendingFees.plus(deltaFees).minus(withdrawFees);
    fundEntity.totalWithdrewFees = fundEntity.totalFees.minus(fundEntity.totalPendingFees);
    let fundSummary = FundSummary.load("1");
    fundSummary.totalFees = fundSummary.totalFees.plus(deltaFees);
    fundSummary.totalPendingFees = fundSummary.totalPendingFees.plus(deltaFees).minus(withdrawFees);
    fundSummary.totalWithdrewFees = fundSummary.totalFees.minus(fundSummary.totalPendingFees);

    let manager = Manager.load(fundEntity.manager);
    manager.totalFees = manager.totalFees.plus(deltaFees);
    manager.totalPendingFees = manager.totalPendingFees.plus(deltaFees).minus(withdrawFees);
    manager.totalWithdrewFees = manager.totalFees.minus(manager.totalPendingFees);

    fromInvestor.save();
    toInvestor.save();
    fundEntity.save();
    fundSummary.save();
    manager.save();

    updateFundDayData(event.block, fundEntity, totalShare);
}

export function createInvestorEntity(fundAddr: Address, userAddr: Address): Investor {
    let ID = fundAddr.toHexString() + "-" + userAddr.toHexString();
    let investor = Investor.load(ID) as Investor;

    if (investor === null) {
        investor = new Investor(ID);
        investor.summary = userAddr.toHex();
        investor.fund = fundAddr.toHexString();

        investor.share = ZERO_BI;
        investor.totalInvestment = ZERO_BD;
        investor.totalInvestmentUSD = ZERO_BD;
        investor.totalDepositedAmount = ZERO_BD;
        investor.totalDepositedAmountUSD = ZERO_BD;
        investor.totalWithdrewAmount = ZERO_BD;
        investor.totalWithdrewAmountUSD = ZERO_BD;

        investor.lastedSettlementPrice = ZERO_BD;
        investor.totalFees = ZERO_BD;
        investor.totalPendingFees = ZERO_BD;
        investor.totalWithdrewFees = ZERO_BD;

        investor.save();

        let investorSummary = InvestorSummary.load(userAddr.toHex());
        if (!investorSummary) {
            investorSummary = new InvestorSummary(userAddr.toHex());
            investorSummary.totalInvestmentUSD = ZERO_BD;
            investorSummary.save();
        }
    }

    return investor;
}

//初始化时这个是每个基金都要做的操作
export function handleDeposit(event: DepositEvent): void {
    let fundEntity = Fund.load(event.address.toHex()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(event.address);

    let txId = event.transaction.hash.toHex();
    let transaction = Transaction.load(txId) || new Transaction(txId);
    let id = txId + "-" + BigInt.fromI32(transaction.deposits.length).toString();
    transaction.deposits = transaction.deposits.concat([id]);
    transaction.fund = event.address.toHex();
    syncTxStatusDataWithEvent(transaction as Transaction, event as ethereum.Event);

    let depositTx = DepositTx.load(id) || new DepositTx(id);
    depositTx.transaction = txId;
    depositTx.fund = event.address.toHexString();
    depositTx.owner = event.params.owner;
    depositTx.amount = convertTokenToDecimal(event.params.amount, fundTokenEntity.decimals);
    depositTx.amountUSD = depositTx.amount.times(getTokenPriceUSD(fundTokenEntity));
    depositTx.share = event.params.share;
    depositTx.investor = event.address.toHexString() + "-" + event.params.owner.toHexString();

    syncFundStatusData(fundEntity, fundTokenEntity, fund);
    fundEntity.totalSupply = fund.totalSupply();
    fundEntity.totalInvestment = convertTokenToDecimal(fund.totalInvestment(), fundTokenEntity.decimals);
    fundEntity.totalInvestmentUSD = fundEntity.totalInvestmentUSD.plus(depositTx.amountUSD);
    fundEntity.totalDepositedAmount = fundEntity.totalDepositedAmount.plus(depositTx.amount);
    fundEntity.totalDepositedAmountUSD = fundEntity.totalDepositedAmountUSD.plus(depositTx.amountUSD);
    // fundEntity.totalWithdrewAmount = fundEntity.totalWithdrewAmount;

    let deltaFees = updateFundPools(fundEntity, fundTokenEntity, fund);
    let totalShare = convertTokenToDecimal(fundEntity.totalSupply.minus(event.params.share), fundEntity.decimals);
    let sharePrice = totalShare.gt(ZERO_BD) ? deltaFees.div(totalShare) : ZERO_BD;
    let lastedSettlementPrice = fundEntity.lastedSettlementPrice.plus(sharePrice);

    let investor = createInvestorEntity(event.address, event.params.owner);
    let investorSummary = InvestorSummary.load(event.params.owner.toHex());
    let lastedShare = convertTokenToDecimal(investor.share, fundEntity.decimals);
    let investorFees = lastedSettlementPrice.minus(investor.lastedSettlementPrice).times(lastedShare);
    investor.lastedSettlementPrice = lastedSettlementPrice;
    investor.totalFees = investor.totalFees.plus(investorFees);
    investor.totalPendingFees = investor.totalPendingFees.plus(investorFees);

    investor.share = investor.share.plus(event.params.share);
    investor.totalInvestment = investor.totalInvestment.plus(depositTx.amount);
    investor.totalInvestmentUSD = investor.totalInvestmentUSD.plus(depositTx.amountUSD);
    investorSummary.totalInvestmentUSD = investorSummary.totalInvestmentUSD.plus(depositTx.amountUSD);
    investor.totalDepositedAmount = investor.totalDepositedAmount.plus(depositTx.amount);
    investor.totalDepositedAmountUSD = investor.totalDepositedAmountUSD.plus(depositTx.amountUSD);
    // investor.totalWithdrewAmount = investor.totalWithdrewAmount;

    fundEntity.totalFees = fundEntity.totalFees.plus(deltaFees);
    fundEntity.lastedSettlementPrice = lastedSettlementPrice;
    fundEntity.totalPendingFees = fundEntity.totalPendingFees.plus(deltaFees);
    let fundSummary = FundSummary.load("1");
    fundSummary.totalFees = fundSummary.totalFees.plus(deltaFees);
    fundSummary.totalPendingFees = fundSummary.totalPendingFees.plus(deltaFees);
    fundSummary.totalInvestmentUSD = fundSummary.totalInvestmentUSD.plus(depositTx.amountUSD);
    fundSummary.totalAssetsUSD = fundSummary.totalAssetsUSD.plus(depositTx.amountUSD);

    let manager = Manager.load(fundEntity.manager);
    manager.totalInvestmentUSD = manager.totalInvestmentUSD.plus(depositTx.amountUSD);
    manager.totalAssetsUSD = manager.totalAssetsUSD.plus(depositTx.amountUSD);
    manager.totalFees = manager.totalFees.plus(deltaFees);
    manager.totalPendingFees = manager.totalPendingFees.plus(deltaFees);
    // manager.totalWithdrewFees = manager.totalWithdrewFees.plus(deltaFees);

    depositTx.save();
    transaction.save();
    fundEntity.save();
    investor.save();
    investorSummary.save();
    fundSummary.save();
    manager.save();

    updateInvestorDayData(event as DepositEvent, investor, lastedShare);
    updateFundDayData(event.block, fundEntity, totalShare);
}

export function handleWithdraw(event: WithdrawEvent): void {
    let fundEntity = Fund.load(event.address.toHex()) as Fund;
    let fundTokenEntity = Token.load(fundEntity.fundToken) as Token;
    let fund = FundContract.bind(event.address);

    let txId = event.transaction.hash.toHex();
    let transaction = Transaction.load(txId) || new Transaction(txId);
    let id = txId + "-" + BigInt.fromI32(transaction.withdraws.length).toString();
    transaction.withdraws = transaction.withdraws.concat([id]);
    transaction.fund = event.address.toHex();
    syncTxStatusDataWithEvent(transaction as Transaction, event as ethereum.Event);

    let withdrawTx = WithdrawTx.load(id) || new WithdrawTx(id);
    withdrawTx.transaction = txId;
    withdrawTx.fund = event.address.toHexString();
    withdrawTx.owner = event.params.owner;
    withdrawTx.amount = convertTokenToDecimal(event.params.amount, fundTokenEntity.decimals);
    withdrawTx.amountUSD = withdrawTx.amount.times(getTokenPriceUSD(fundTokenEntity));
    withdrawTx.share = event.params.share;
    withdrawTx.investor = event.address.toHexString() + "-" + event.params.owner.toHexString();

    syncFundStatusData(fundEntity, fundTokenEntity, fund);
    fundEntity.totalSupply = fund.totalSupply();
    fundEntity.totalInvestment = convertTokenToDecimal(fund.totalInvestment(), fundTokenEntity.decimals);
    // fundEntity.totalDepositedAmount = fundEntity.totalDepositedAmount;
    fundEntity.totalWithdrewAmount = fundEntity.totalWithdrewAmount.plus(withdrawTx.amount);

    let deltaFees = updateFundPools(fundEntity, fundTokenEntity, fund);
    let totalShare = convertTokenToDecimal(fundEntity.totalSupply.plus(event.params.share), fundEntity.decimals);
    let deltaPerSharePrice = totalShare.gt(ZERO_BD) ? deltaFees.div(totalShare) : ZERO_BD;
    let lastedSettlementPrice = fundEntity.lastedSettlementPrice.plus(deltaPerSharePrice);

    let investor = createInvestorEntity(event.address, event.params.owner);
    let investorSummary = InvestorSummary.load(event.params.owner.toHex());
    let investorLastedShare = convertTokenToDecimal(investor.share, fundEntity.decimals);
    let withdrewShare = convertTokenToDecimal(event.params.share, fundEntity.decimals);
    let investorDeltaFees = lastedSettlementPrice.minus(investor.lastedSettlementPrice).times(investorLastedShare);
    let withdrawFees = lastedSettlementPrice.minus(investor.lastedSettlementPrice).times(withdrewShare)
        .plus(investor.totalPendingFees.times(withdrewShare).div(investorLastedShare.gt(ZERO_BD) ? investorLastedShare : ZERO_BD));

    investor.lastedSettlementPrice = lastedSettlementPrice;
    investor.totalFees = investor.totalFees.plus(investorDeltaFees);
    investor.totalPendingFees = investor.totalPendingFees.plus(investorDeltaFees).minus(withdrawFees);
    investor.totalWithdrewFees = investor.totalFees.plus(investor.totalPendingFees);

    investor.share = investor.share.minus(event.params.share);
    let totalInvestmentLasted = investor.totalInvestment;
    investor.totalInvestment = convertTokenToDecimal(fund.investmentOf(event.params.owner), fundTokenEntity.decimals);
    let withdrawInvestment = totalInvestmentLasted.minus(investor.totalInvestment);
    let withdrawInvestmentUSD = totalInvestmentLasted.gt(ZERO_BD) ? withdrawInvestment.times(investor.totalInvestmentUSD).div(totalInvestmentLasted):ZERO_BD;

    investor.totalInvestmentUSD = investor.totalInvestmentUSD.minus(withdrawInvestmentUSD);
    investorSummary.totalInvestmentUSD = investorSummary.totalInvestmentUSD.minus(withdrawInvestmentUSD);
    // investor.totalDepositedAmount = investor.totalDepositedAmount;
    investor.totalWithdrewAmount = investor.totalWithdrewAmount.plus(withdrawTx.amount);
    investor.totalWithdrewAmountUSD = investor.totalWithdrewAmountUSD.plus(withdrawTx.amountUSD);

    fundEntity.lastedSettlementPrice = lastedSettlementPrice;
    fundEntity.totalFees = fundEntity.totalFees.plus(deltaFees);
    fundEntity.totalPendingFees = fundEntity.totalPendingFees.plus(deltaFees).minus(withdrawFees);
    fundEntity.totalWithdrewFees = fundEntity.totalFees.minus(fundEntity.totalPendingFees);
    fundEntity.totalInvestmentUSD = fundEntity.totalInvestmentUSD.minus(withdrawInvestmentUSD);
    fundEntity.totalWithdrewAmountUSD = fundEntity.totalWithdrewAmountUSD.plus(withdrawTx.amountUSD);
    let fundSummary = FundSummary.load("1");
    fundSummary.totalFees = fundSummary.totalFees.plus(deltaFees);
    fundSummary.totalPendingFees = fundSummary.totalPendingFees.plus(deltaFees).minus(withdrawFees);
    fundSummary.totalWithdrewFees = fundSummary.totalFees.minus(fundSummary.totalPendingFees);
    fundSummary.totalInvestmentUSD = fundSummary.totalInvestmentUSD.minus(withdrawInvestmentUSD);
    fundSummary.totalAssetsUSD = fundSummary.totalAssetsUSD.minus(withdrawTx.amountUSD);

    let manager = Manager.load(fundEntity.manager);
    manager.totalFees = manager.totalFees.plus(deltaFees);
    manager.totalPendingFees = manager.totalPendingFees.plus(deltaFees).minus(withdrawFees);
    manager.totalWithdrewFees = manager.totalFees.minus(manager.totalPendingFees);
    manager.totalInvestmentUSD = manager.totalInvestmentUSD.minus(withdrawInvestmentUSD);
    manager.totalAssetsUSD = manager.totalAssetsUSD.minus(withdrawTx.amountUSD);

    withdrawTx.save();
    transaction.save();
    fundEntity.save();
    investor.save();
    investorSummary.save();
    fundSummary.save();
    manager.save();

    updateInvestorDayData(event as DepositEvent, investor, investorLastedShare);
    updateFundDayData(event.block, fundEntity, totalShare);
}
