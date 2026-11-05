'use strict';

// Lambda@Edge viewer-response.
//
// It runs before the response reaches the viewer whether the object came from
// the origin or the cache, but it does not run for an origin status of 400 or
// higher, for a custom error page, or for a response a viewer-request function
// generated. It cannot change the status code.
exports.handler = async (event) => {
    const cf = event.Records[0].cf;
    const response = cf.response;
    response.headers['x-edge-viewer-response'] = [{ key: 'X-Edge-Viewer-Response', value: 'seen' }];
    return response;
};
