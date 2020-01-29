const sodium = require('tweetsodium');
const Octokit = require("@octokit/rest");

const githubRepo = {
  owner: 'qoomon',
  repo: 'sandbox'
};

const secrets = {
  'AWS_ACCES_KEY': new Date().toString(),
};

(async function() {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const publicKey = (await octokit.actions.getPublicKey(githubRepo)).data;
  const secretEncryptor = new SecretEncryptor(publicKey.key);
  
  Object.entries(secrets).forEach(([name, value]) => {
    octokit.actions.createOrUpdateSecretForRepo({
      ...githubRepo,
      name,
      encrypted_value: secretEncryptor.encrypt(value),
      key_id: publicKey.key_id
    });
  });

})().catch(console.log);

function SecretEncryptor(publicKey) {
  const publicKeyBytes = Buffer.from(publicKey, 'base64');
  
  this.encrypt = (secretValue) => {
    const secretValueBytes = Buffer.from(secretValue);
    const encryptedValueBytes = Buffer.from(sodium.seal(secretValueBytes, publicKeyBytes));
    return encryptedValueBytes.toString('base64');
  }
}
