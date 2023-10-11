import {APIGatewayProxyEventV2, APIGatewayProxyHandlerV2, Context} from "aws-lambda";
import {getReasonPhrase} from "http-status-codes";
import {SecretsManager} from "@aws-sdk/client-secrets-manager";
import process from "process";

export function withErrorHandler(errorHandler: (error: any, event: APIGatewayProxyEventV2, context: Context) => any, handler: APIGatewayProxyHandlerV2): APIGatewayProxyHandlerV2 {
    return (async (event, context, callback) => {
        try {
            return await handler(event, context, callback)
        } catch (error: any) {
            return await errorHandler(error, event, context)
        }
    })
}

export function jsonResponse(statusCode: number, body: any) {
    return {
        statusCode,
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body, null, 2)
    }
}

export function jsonErrorResponse(statusCode: number, message?: string, details?: Object) {
    return jsonResponse(statusCode, {
        error: {
            message: message ?? getReasonPhrase(statusCode),
            details,
        }
    })
}


// ---------------------------------------------------------------------------------------------------------------------

const secretsManager = new SecretsManager({region: process.env.AWS_REGION})

export async function getSecretString(secretId: string) {
    const secret = await secretsManager.getSecretValue({SecretId: secretId});
    if (secret.SecretString === undefined) throw Error("Secret is not a string")
    return secret.SecretString
}

export async function getSecretObject<T extends Object>(secretId: string) {
    return await getSecretString(secretId).then(it => JSON.parse(it) as T)
}
