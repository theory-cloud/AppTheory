import cf from 'cloudfront';

// CloudFront Function with a KeyValueStore association, runtime 2.0.
//
// /kv/meta           -> the store's key count and timestamps through meta()
// /kv/config         -> a JSON value through get(key, {format: 'json'})
// /kv/<key>          -> 302 to the value of <key>
// /kv/<missing>      -> 404 after exists() said the key is absent
const kvs = cf.kvs();

async function handler(event) {
    const uri = event.request.uri;
    const key = uri.slice('/kv/'.length);

    if (key === 'meta') {
        const metadata = await kvs.meta();
        return {
            statusCode: 200,
            statusDescription: 'OK',
            headers: { 'content-type': { value: 'application/json' } },
            body: {
                encoding: 'text',
                data: JSON.stringify({
                    keyCount: metadata.keyCount,
                    createdAt: metadata.creationDateTime,
                    updatedAt: metadata.lastUpdatedDateTime,
                }),
            },
        };
    }

    if (!(await kvs.exists(key))) {
        return {
            statusCode: 404,
            statusDescription: 'Not Found',
            headers: { 'content-type': { value: 'text/plain' } },
            body: { encoding: 'text', data: 'missing key ' + key },
        };
    }

    if (key === 'config') {
        const config = await kvs.get(key, { format: 'json' });
        return {
            statusCode: 200,
            statusDescription: 'OK',
            headers: { 'content-type': { value: 'application/json' } },
            body: { encoding: 'text', data: JSON.stringify(config) },
        };
    }

    const target = await kvs.get(key);
    return {
        statusCode: 302,
        statusDescription: 'Found',
        headers: {
            'content-type': { value: 'text/plain' },
            location: { value: target },
        },
        body: { encoding: 'text', data: '' },
    };
}
