import Adapter from 'src/adapter';
import bidfactory from 'src/bidfactory';
import bidmanager from 'src/bidmanager';
import * as utils from 'src/utils';
import { ajax } from 'src/ajax';
import { STATUS, S2S } from 'src/constants';
import { cookieSet } from 'src/cookie.js';
import adaptermanager from 'src/adaptermanager';
import { config } from 'src/config';

const getConfig = config.getConfig;

const TYPE = S2S.SRC;
const cookieSetUrl = 'https://acdn.adnxs.com/cookieset/cs.js';
let _synced = false;

/**
 * Try to convert a value to a type.
 * If it can't be done, the value will be returned.
 *
 * @param {string} typeToConvert The target type. e.g. "string", "number", etc.
 * @param {*} value The value to be converted into typeToConvert.
 */
function tryConvertType(typeToConvert, value) {
  if (typeToConvert === 'string') {
    return value && value.toString();
  } else if (typeToConvert === 'number') {
    return Number(value);
  } else {
    return value;
  }
}

const tryConvertString = tryConvertType.bind(null, 'string');
const tryConvertNumber = tryConvertType.bind(null, 'number');

const paramTypes = {
  'appnexus': {
    'member': tryConvertString,
    'invCode': tryConvertString,
    'placementId': tryConvertNumber
  },
  'rubicon': {
    'accountId': tryConvertNumber,
    'siteId': tryConvertNumber,
    'zoneId': tryConvertNumber
  },
  'indexExchange': {
    'siteID': tryConvertNumber
  },
  'audienceNetwork': {
    'placementId': tryConvertString
  },
  'pubmatic': {
    'publisherId': tryConvertString,
    'adSlot': tryConvertString
  },
  'districtm': {
    'member': tryConvertString,
    'invCode': tryConvertString,
    'placementId': tryConvertNumber
  },
  'pulsepoint': {
    'cf': tryConvertString,
    'cp': tryConvertNumber,
    'ct': tryConvertNumber
  },
};

let _cookiesQueued = false;

/**
 * Bidder adapter for Prebid Server
 */
function PrebidServer() {
  let baseAdapter = new Adapter('prebidServer');
  let config;

  baseAdapter.setConfig = function(s2sconfig) {
    config = s2sconfig;
  };

  function convertTypes(adUnits) {
    adUnits.forEach(adUnit => {
      adUnit.bids.forEach(bid => {
        const types = paramTypes[bid.bidder] || [];
        Object.keys(types).forEach(key => {
          if (bid.params[key]) {
            const converted = types[key](bid.params[key]);
            if (converted !== bid.params[key]) {
              utils.logMessage(`Mismatched type for Prebid Server : ${bid.bidder} : ${key}. Required Type:${types[key]}`);
            }
            bid.params[key] = converted;

            // don't send invalid values
            if (isNaN(bid.params[key])) {
              delete bid.params.key;
            }
          }
        });
      });
    });
  }

  /* Prebid executes this function when the page asks to send out bid requests */
  baseAdapter.callBids = function(bidRequest) {
    const isDebug = !!getConfig('debug');
    convertTypes(bidRequest.ad_units);
    let requestJson = {
      account_id: config.accountId,
      tid: bidRequest.tid,
      max_bids: config.maxBids,
      timeout_millis: config.timeout,
      url: utils.getTopWindowUrl(),
      prebid_version: '$prebid.version$',
      ad_units: bidRequest.ad_units.filter(hasSizes),
      is_debug: isDebug
    };

    // in case config.bidders contains invalid bidders, we only process those we sent requests for.
    const requestedBidders = requestJson.ad_units.map(adUnit => adUnit.bids.map(bid => bid.bidder).filter(utils.uniques)).reduce(utils.flatten).filter(utils.uniques);
    function processResponse(response) {
      handleResponse(response, requestedBidders);
    }
    const payload = JSON.stringify(requestJson);
    ajax(config.endpoint, processResponse, payload, {
      contentType: 'text/plain',
      withCredentials: true
    });
  };

  // at this point ad units should have a size array either directly or mapped so filter for that
  function hasSizes(unit) {
    return unit.sizes && unit.sizes.length;
  }

  /**
   * Run a cookie sync for the given type, url, and bidder
   *
   * @param {string} type the type of sync, "image", "redirect", "iframe"
   * @param {string} url the url to sync
   * @param {string} bidder name of bidder doing sync for
   */
  function doBidderSync(type, url, bidder) {
    if (!url) {
      utils.logError(`No sync url for bidder "${bidder}": ${url}`);
    } else if (type === 'image' || type === 'redirect') {
      utils.logMessage(`Invoking image pixel user sync for bidder: "${bidder}"`);
      utils.triggerPixel(url);
    } else if (type == 'iframe') {
      utils.logMessage(`Invoking iframe user sync for bidder: "${bidder}"`);
      utils.insertUserSyncIframe(url);
    } else {
      utils.logError(`User sync type "${type}" not supported for bidder: "${bidder}"`);
    }
  }

  /* Notify Prebid of bid responses so bids can get in the auction */
  function handleResponse(response, requestedBidders) {
    let result;
    try {
      result = JSON.parse(response);

      if (result.status === 'OK' || result.status === 'no_cookie') {
        if (result.bidder_status) {
          result.bidder_status.forEach(bidder => {
            if (bidder.no_cookie && !_cookiesQueued) {
              doBidderSync(bidder.usersync.type, bidder.usersync.url, bidder.bidder);
            }
          });
        }

        if (result.bids) {
          result.bids.forEach(bidObj => {
            let bidRequest = utils.getBidRequest(bidObj.bid_id);
            let cpm = bidObj.price;
            let status;
            if (cpm !== 0) {
              status = STATUS.GOOD;
            } else {
              status = STATUS.NO_BID;
            }

            let bidObject = bidfactory.createBid(status, bidRequest);
            bidObject.source = TYPE;
            bidObject.creative_id = bidObj.creative_id;
            bidObject.bidderCode = bidObj.bidder;
            bidObject.cpm = cpm;
            bidObject.ad = bidObj.adm;
            if (bidObj.nurl) {
              bidObject.ad += utils.createTrackPixelHtml(decodeURIComponent(bidObj.nurl));
            }
            bidObject.width = bidObj.width;
            bidObject.height = bidObj.height;
            bidObject.adserverTargeting = bidObj.ad_server_targeting;
            if (bidObj.deal_id) {
              bidObject.dealId = bidObj.deal_id;
            }

            bidmanager.addBidResponse(bidObj.code, bidObject);
          });
        }

        const receivedBidIds = result.bids ? result.bids.map(bidObj => bidObj.bid_id) : [];

        // issue a no-bid response for every bid request that can not be matched with received bids
        requestedBidders.forEach(bidder => {
          utils
            .getBidderRequestAllAdUnits(bidder)
            .bids.filter(bidRequest => !receivedBidIds.includes(bidRequest.bidId))
            .forEach(bidRequest => {
              let bidObject = bidfactory.createBid(STATUS.NO_BID, bidRequest);
              bidObject.source = TYPE;
              bidObject.adUnitCode = bidRequest.placementCode;
              bidObject.bidderCode = bidRequest.bidder;

              bidmanager.addBidResponse(bidObject.adUnitCode, bidObject);
            });
        });
      }
      if (result.status === 'no_cookie' && config.cookieSet) {
        // cookie sync
        cookieSet(cookieSetUrl);
      }
    } catch (error) {
      utils.logError(error);
    }

    if (!result || (result.status && result.status.includes('Error'))) {
      utils.logError('error parsing response: ', result.status);
    }
  }
  /**
   * @param  {} {bidders} list of bidders to request user syncs for.
   */
  baseAdapter.queueSync = function({bidderCodes}) {
    if (_synced) {
      return;
    }
    _synced = true;
    const payload = JSON.stringify({
      uuid: utils.generateUUID(),
      bidders: bidderCodes
    });
    ajax(config.syncEndpoint, (response) => {
      try {
        response = JSON.parse(response);
        if (response.status === 'ok') {
          bidderCodes.forEach(code => StorageManager.add(pbjsSyncsKey, code, true));
        }
        response.bidder_status.forEach(bidder => doBidderSync(bidder.usersync.type, bidder.usersync.url, bidder.bidder));
      } catch (e) {
        utils.logError(e);
      }
    },
    payload, {
      contentType: 'text/plain',
      withCredentials: true
    });
  };

  return Object.assign(this, {
    queueSync: baseAdapter.queueSync,
    setConfig: baseAdapter.setConfig,
    callBids: baseAdapter.callBids,
    setBidderCode: baseAdapter.setBidderCode,
    type: TYPE
  });
}

adaptermanager.registerBidAdapter(new PrebidServer(), 'prebidServer');

module.exports = PrebidServer;
