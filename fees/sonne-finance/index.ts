import * as sdk from "@defillama/sdk";
import { Adapter, FetchResultFees } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";
import { getPrices } from "../../utils/prices";
import { getBlock } from "../../helpers/getBlock";
import { ethers } from "ethers";
import {
  getTimestampAtStartOfDayUTC,
  getTimestampAtStartOfNextDayUTC,
} from "../../utils/date";
import {
  getAllMarkets,
  getMarketDetails,
  getVeloGaugeDetails,
} from "./helpers";
import { CTokenABI, cTokenInterface } from "./_abi";
import { IAccrueInterestLog, IContext } from "./_types";

const unitroller = "0x60CF091cD3f50420d50fD7f707414d0DF4751C58";
const veloGauge = "0x3786d4419d6b4a902607ceb2bb319bb336735df8";
const veloToken = "0x3c8b650257cfb5f272f799f5e2b4e65093a11a05";
const veVeloHolder = "0x17063ad4e83b0aba4ca0f3fc3a9794e807a00ed7";

const getMarketInterestLogs = async (
  market: string,
  fromBlock: number,
  toBlock: number
): Promise<IAccrueInterestLog[]> => {
  const logs = (
    await sdk.api.util.getLogs({
      target: market,
      topic: CTokenABI.accrueInterest,
      fromBlock: fromBlock,
      toBlock: toBlock,
      topics: [cTokenInterface.getEventTopic("AccrueInterest")],
      keys: [],
      chain: CHAIN.OPTIMISM,
    })
  ).output;

  const parsedLogs = logs.map((log: any) => cTokenInterface.parseLog(log));

  return parsedLogs.map((x) => ({
    market: market,
    cashPrior: x.args.cashPrior,
    interestAccumulated: x.args.interestAccumulated,
    borrowIndexNew: x.args.borrowIndexNew,
    totalBorrowsNew: x.args.totalBorrowsNew,
  }));
};

const getContext = async (timestamp: number): Promise<IContext> => {
  const todaysTimestamp = getTimestampAtStartOfDayUTC(timestamp);
  const endToDayTimestamp = getTimestampAtStartOfNextDayUTC(timestamp);

  const currentBlock = await getBlock(timestamp, CHAIN.OPTIMISM, {});
  const todaysBlock = await getBlock(todaysTimestamp, CHAIN.OPTIMISM, {});
  const endTodayBlock = await getBlock(endToDayTimestamp, CHAIN.OPTIMISM, {});

  const allMarketAddressess = await getAllMarkets(unitroller, CHAIN.OPTIMISM);
  const { underlyings, reserveFactors } = await getMarketDetails(
    allMarketAddressess,
    CHAIN.OPTIMISM
  );

  const prices = await getPrices(
    [
      ...underlyings.map((x) => `${CHAIN.OPTIMISM}:${x}`),
      `${CHAIN.OPTIMISM}:${veloToken}`,
    ],
    timestamp
  );

  return {
    currentTimestamp: timestamp,
    startTimestamp: todaysTimestamp,
    endTimestamp: endToDayTimestamp,
    currentBlock: currentBlock,
    startBlock: todaysBlock,
    endBlock: endTodayBlock,
    markets: allMarketAddressess,
    underlyings,
    reserveFactors,
    prices,
  };
};

const getDailyProtocolFees = async ({
  markets,
  underlyings,
  reserveFactors,
  prices,
  startBlock,
  endBlock,
}: IContext) => {
  let dailyProtocolFees = 0;
  let dailyProtocolRevenue = 0;

  const logs = (
    await Promise.all(
      markets.map((market) => {
        return getMarketInterestLogs(market, startBlock, endBlock);
      })
    )
  ).flat();

  logs.forEach((log) => {
    const marketIndex = markets.indexOf(log.market);
    const underlying = underlyings[marketIndex].toLowerCase();
    const price = prices[`${CHAIN.OPTIMISM}:${underlying}`];

    const interestTokens = +ethers.utils.formatUnits(
      log.interestAccumulated,
      price.decimals
    );
    const reserveFactor = +ethers.utils.formatUnits(
      reserveFactors[marketIndex],
      18
    );
    const interestUSD = interestTokens * price.price;

    dailyProtocolFees += interestUSD;
    dailyProtocolRevenue += interestUSD * reserveFactor;
  });

  return {
    dailyProtocolFees,
    dailyProtocolRevenue,
  };
};

const getDailyVeloRewards = async (context: IContext) => {
  const {
    currentBlock,
    currentTimestamp,
    startTimestamp,
    endTimestamp,
    prices,
  } = context;

  const { lastEarn, earned } = await getVeloGaugeDetails(
    veloGauge,
    veloToken,
    veVeloHolder,
    CHAIN.OPTIMISM,
    currentBlock
  );

  const timespan = endTimestamp - startTimestamp;
  const earnedTimespan = currentTimestamp - lastEarn;
  const ratio = timespan / earnedTimespan;

  const priceVelo = prices[`${CHAIN.OPTIMISM}:${veloToken}`];
  const earnedTokens = +ethers.utils.formatUnits(earned, priceVelo.decimals);
  const todayEarnedTokens = earnedTokens * ratio;
  const todayEarnedUSD = todayEarnedTokens * priceVelo.price;

  return todayEarnedUSD;
};

const fetch = async (timestamp: number): Promise<FetchResultFees> => {
  const context = await getContext(timestamp);

  const { dailyProtocolFees, dailyProtocolRevenue } =
    await getDailyProtocolFees(context);

  const dailyVeloRewards = await getDailyVeloRewards(context);

  return {
    timestamp,
    dailyFees: dailyProtocolFees.toString(),
    dailyRevenue: dailyProtocolRevenue.toString(),
    dailyHoldersRevenue: (dailyProtocolRevenue + dailyVeloRewards).toString(),
  };
};

const adapter: Adapter = {
  adapter: {
    [CHAIN.OPTIMISM]: {
      fetch: fetch,
      start: async () => 1664582400,
      runAtCurrTime: true,
    },
  },
};

export default adapter;
