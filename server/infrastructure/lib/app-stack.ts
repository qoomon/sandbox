import * as iam from "aws-cdk-lib/aws-iam";
import {OpenIdConnectProvider} from "aws-cdk-lib/aws-iam";
import {CfnOutput, Duration, SecretValue, Stack, StackProps} from 'aws-cdk-lib'
import {Construct} from 'constructs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import {FunctionUrlAuthType} from 'aws-cdk-lib/aws-lambda'
import * as path from 'path'
import * as secretManager from "aws-cdk-lib/aws-secretsmanager";

const API_ACCESS_ROLE_NAME = 'github-access-manager-api-access'
const API_ACCESS_ROLE_OIDC_SUB: string | string[] = [
    'repo:CHANGE-ME/*:ref:*',
    'repo:CHANGE-ME/*:environment:*',
];

export class AppStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props)


        // --- API Access Token Function--------------------------------------------------------------------------------

        const httpApiAccessTokenFunction = new lambda.Function(this, 'HttpApiAccessTokenFunction', {
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            memorySize: 128,
            timeout: Duration.seconds(30),
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
        })

        // --- add function url
        const httpApiAccessTokenFunctionUrl = httpApiAccessTokenFunction.addFunctionUrl({
            authType: FunctionUrlAuthType.AWS_IAM,
        })
        new CfnOutput(this, 'HttpApiUrl', {value: httpApiAccessTokenFunctionUrl.url})
        new CfnOutput(this, 'HttpApiRegion', {value: httpApiAccessTokenFunctionUrl.stack.region})

        // --- Github App Secrets---------------------------------------------------------------------------------------

        const githubAppSecret = new secretManager.Secret(this, "GithubAppIdSecret", {
            secretName: `${this.stackName}/GithubApp`, secretObjectValue: {
                appId: SecretValue.unsafePlainText('change-me'),
                privateKey: SecretValue.unsafePlainText('change-me'),
            },
        })
        new CfnOutput(this, 'GithubAppSecretName', {value: githubAppSecret.secretName})
        httpApiAccessTokenFunction.addEnvironment("GITHUB_APP_SECRETS_NAME", githubAppSecret.secretName)
        githubAppSecret.grantRead(httpApiAccessTokenFunction.role!)


        // --- API Access Role------------------------------------------------------------------------------------------

        const githubOidcProvider = OpenIdConnectProvider.fromOpenIdConnectProviderArn(
            this, 'HttpApiAuthOidcProvider',
            `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
        )

        const httpApiAccessRole = new iam.Role(this, 'HttpApiAccessRole', {
            roleName: API_ACCESS_ROLE_NAME,
            maxSessionDuration: Duration.hours(1),
            assumedBy: new iam.OpenIdConnectPrincipal(githubOidcProvider, {
                'StringEquals': {[`${githubOidcProvider.openIdConnectProviderIssuer}:aud`]: 'sts.amazonaws.com'},
                'ForAnyValue:StringLike': {[`${githubOidcProvider.openIdConnectProviderIssuer}:sub`]: API_ACCESS_ROLE_OIDC_SUB},
            }),
        })

        // --- grant InvokeUrl access to API Access Role
        new CfnOutput(this, 'HttpApiAccessRoleArn', {value: httpApiAccessRole.roleArn})
        httpApiAccessTokenFunctionUrl.grantInvokeUrl(httpApiAccessRole)
    }
}
