'use strict';

/*
 * The serverId a request body names, when it may be trusted for targeting.
 *
 * express.json parses a JSON body before any capability check runs, so the
 * check and the handler read the same value. A multipart body is parsed later,
 * by multer inside the route, and fills req.body as the form streams in: a
 * capability check that ran first saw no body serverId (and authorized the
 * header, query, or active server), while the handler after multer would see
 * the form field and act on a different server. Multipart bodies therefore
 * never name the target server; the header or query string does.
 */
function bodyServerId(req) {
  const type = String((req && req.headers && req.headers['content-type']) || '');
  if (/^multipart\//i.test(type)) return undefined;
  return req && req.body ? req.body.serverId : undefined;
}

module.exports = { bodyServerId };
