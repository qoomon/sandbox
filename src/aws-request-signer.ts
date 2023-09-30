import {SignatureV4} from "@smithy/signature-v4";
import {HttpRequest} from "@smithy/protocol-http";
import {BeforeRequestHook} from "ky";

export function AwsRequestSigner(signer: SignatureV4): BeforeRequestHook {
    return async (request: Request) => {
        const requestUrl = new URL(request.url);
        const requestHeaders = Object.fromEntries(request.headers.entries());
        if (requestHeaders["Authorization"]) {
            // preserve Authorization header
            requestHeaders["X-Authorization"] = requestHeaders["Authorization"];
            delete requestHeaders["Authorization"];
        }
        const canonicalRequest = new HttpRequest({
            hostname: requestUrl.hostname,
            // port: requestUrl.port ? parseInt(requestUrl.port) : undefined,
            path: requestUrl.pathname,
            protocol: requestUrl.protocol,
            method: request.method,
            body: await request.text(),
            query: Object.fromEntries(requestUrl.searchParams.entries()),
            headers: {
                ...requestHeaders,
                "Host": requestUrl.host,
            },
        });

        const signedCanonicalRequest = await signer.sign(canonicalRequest);

        return new Request(request, {
            headers: signedCanonicalRequest.headers,
            body: signedCanonicalRequest.body,
        })
    }
}

