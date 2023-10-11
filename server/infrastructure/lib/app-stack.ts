import * as iam from "aws-cdk-lib/aws-iam";
import {OpenIdConnectProvider} from "aws-cdk-lib/aws-iam";
import {ArnFormat, CfnOutput, Duration, SecretValue, Stack, StackProps} from 'aws-cdk-lib'
import {Construct} from 'constructs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as apiGateway from '@aws-cdk/aws-apigatewayv2-alpha'
import {HttpLambdaIntegration} from '@aws-cdk/aws-apigatewayv2-integrations-alpha'
import {HttpIamAuthorizer} from '@aws-cdk/aws-apigatewayv2-authorizers-alpha';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as path from 'path'
import {HostedZone} from "aws-cdk-lib/aws-route53";
import * as secretManager from "aws-cdk-lib/aws-secretsmanager";

const API_HOSTED_ZONE_NAME: string | undefined = undefined // 'example.com'
const API_DOMAIN_NAME: string | undefined = undefined // 'api.example.com'
const API_ACCESS_ROLE_NAME = 'github-access-manager-api-access'
const API_ACCESS_ROLE_OIDC_SUB: string | string[] = [
    'repo:qoomon/*:ref:*',
    'repo:qoomon/*:environment:*'
]; // TODO adjust to your organization

export class AppStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props)

        // --- GitHub App Secrets --------------------------------------------------------------------------------------

        const githubAppSecrets = new secretManager.Secret(this, "GithubAppIdSecret", {
            secretName: `${this.stackName}/GithubApp`, secretObjectValue: {
                appId: SecretValue.unsafePlainText('change-me'),
                privateKey: SecretValue.unsafePlainText('change-me'),
            },
        })

        // --- API Gateway ---------------------------------------------------------------------------------------------

        const httpApi = new apiGateway.HttpApi(this, 'HttpApi', {
            apiName: 'github-access-manager',
            defaultAuthorizer: new HttpIamAuthorizer(),
            disableExecuteApiEndpoint: !!API_DOMAIN_NAME,
            defaultDomainMapping: API_DOMAIN_NAME ? {
                domainName: new apiGateway.DomainName(this, 'HttpApiDomainName', {
                    domainName: API_DOMAIN_NAME,
                    certificate: new acm.Certificate(this, 'HttpApiDomainCertificate', {
                        domainName: API_DOMAIN_NAME,
                        validation: acm.CertificateValidation.fromDns(
                            HostedZone.fromLookup(this, "HostedZone", {
                                domainName: API_HOSTED_ZONE_NAME ?? API_DOMAIN_NAME.split('.').slice(1).join('.'),
                                privateZone: false,
                            })),
                    }),
                })
            } : undefined,
        })
        new CfnOutput(this, 'HttpApiUrl', {value: httpApi.url!})
        new CfnOutput(this, 'HttpApiRegion', {value: this.region})

        // --- API Access Role------------------------------------------------------------------------------------------

        const githubOidcProvider = OpenIdConnectProvider.fromOpenIdConnectProviderArn(
            this, 'HttpApiAuthOidcProvider',
            `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
        )

        const httpApiAccessRole = new iam.Role(this, 'HttpApiAccessRole', {
            roleName: API_ACCESS_ROLE_NAME,
            assumedBy: new iam.OpenIdConnectPrincipal(githubOidcProvider, {
                'StringEquals': {[`${githubOidcProvider.openIdConnectProviderIssuer}:aud`]: 'sts.amazonaws.com'},
                'ForAnyValue:StringLike': {[`${githubOidcProvider.openIdConnectProviderIssuer}:sub`]: API_ACCESS_ROLE_OIDC_SUB},
            }),
            maxSessionDuration: Duration.hours(1),
            inlinePolicies: {
                'http-api': new iam.PolicyDocument({
                    statements: [new iam.PolicyStatement({
                        actions: ["execute-api:Invoke"],
                        resources: [this.formatArn({
                            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                            service: 'execute-api',
                            resource: httpApi.apiId,
                            resourceName: `*`,
                        })],
                    })],
                }),
            },
        })

        new CfnOutput(this, 'HttpApiAccessRoleArn', {value: httpApiAccessRole.roleArn})

        // --- API Access Token Function--------------------------------------------------------------------------------

        const httpApiAccessTokenFunction = new lambda.Function(this, 'HttpApiAccessTokenFunction', {
            runtime: lambda.Runtime.NODEJS_18_X,
            code: lambda.Code.fromAsset(path.join(__dirname, '..', '..'), {
                bundling: {
                    image: lambda.Runtime.NODEJS_18_X.bundlingImage,
                    workingDirectory: '/asset-input',
                    user: 'root',
                    entrypoint: ['bash', '-c'], command: [[
                        'npm ci', 'npm run build',
                        'cp -a dist/. /asset-output/'
                    ].join(' && ')],
                },
            }),
            handler: 'index.handler',
            timeout: Duration.seconds(30),
            memorySize: 128,
            environment: {
                GITHUB_APP_SECRETS_NAME: githubAppSecrets.secretName,
                API_ENDPOINT_URL: httpApi.apiEndpoint
            },
        })
        githubAppSecrets.grantRead(httpApiAccessTokenFunction.role!)

        httpApi.addRoutes({
            path: '/v1/access_tokens',
            methods: [apiGateway.HttpMethod.POST],
            integration: new HttpLambdaIntegration(httpApiAccessTokenFunction.node.id + 'Integration', httpApiAccessTokenFunction),
        })
    }
}
