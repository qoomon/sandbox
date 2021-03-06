const sodium = require('tweetsodium');
const Octokit = require("@octokit/rest");
const { createTokenAuth } = require("@octokit/auth-token");

const githubRepo = {
  owner: 'qoomon',
  repo: 'sandbox'
};

const secrets = {
  'AWS_ACCES_KEY': new Date().toString(),
};

console.log('process.env.GITHUB_TOKEN ', process.env.GITHUB_TOKEN.length, process.env.GITHUB_TOKEN );

(async function() {
  const octokit = new Octokit({ 
    authStrategy: createTokenAuth,
    auth: process.env.GITHUB_TOKEN 
  });
  const publicKey = (await octokit.actions.getPublicKey(githubRepo)).data;
  const secretEncryptor = new SecretEncryptor(publicKey.key);
  
  for (const [name, value] of Object.entries(secrets)) {
    console.log('update secret', name);
    await octokit.actions.createOrUpdateSecretForRepo({
      ...githubRepo,
      name,
      encrypted_value: secretEncryptor.encrypt(value),
      key_id: publicKey.key_id
    });
  }

})().catch(error => {
  console.error('[ERROR]',error);
  process.exit(1);
});

function SecretEncryptor(publicKey) {
  const publicKeyBytes = Buffer.from(publicKey, 'base64');
  
  this.encrypt = (secretValue) => {
    const secretValueBytes = Buffer.from(secretValue);
    const encryptedValueBytes = Buffer.from(sodium.seal(secretValueBytes, publicKeyBytes));
    return encryptedValueBytes.toString('base64');
  }
}
