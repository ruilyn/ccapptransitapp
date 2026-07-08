/**
 * Loads environment configuration for the server.
 *
 * The MTA retired its old keyless `api-endpoint.mta.info` GTFS-Realtime
 * feeds in favor of `api.mta.info`, which requires an API key (sent as the
 * `x-api-key` header) for every feed, subway included. Register for a free
 * key at https://api.mta.info/ and put it in a local `.env` file (see
 * `.env.example`) as `MTA_API_KEY`.
 */

require('dotenv').config();

const MTA_API_KEY = process.env.MTA_API_KEY || '';

if (!MTA_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn(
    '[Config] MTA_API_KEY not set; using public MTA feeds (no key required). Subway feeds will fail.'
  );
}

module.exports = { MTA_API_KEY };
