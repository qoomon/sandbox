const sodium = require('tweetsodium');
const Octokit = require("@octokit/rest");

const githubRepo = {
  owner: 'qoomon',
  repo: 'sandbox'
};

const githubRepoSecrets = {
  'AWS_ACCES_KEY': new Date().toString(),
};

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

(async function() {

  const publicKeyResponse = await octokit.actions.getPublicKey(githubRepo);
  const publicKeyId = publicKeyResponse.data.key_id;
  const publicKey = publicKeyResponse.data.key;
  const publicKeyBytes = Buffer.from(publicKey, 'base64');

  Object.entries(githubRepoSecrets).map(([name, value]) => ({
    name,
    value
  })).forEach(secret => {
    const secretValueBytes = Buffer.from(secret.value);
    const encryptedValueBytes = sodium.seal(secretValueBytes, publicKeyBytes);
    const encryptedValue = Buffer.from(encryptedValueBytes).toString('base64');
    octokit.actions.createOrUpdateSecretForRepo({
      ...githubRepo,
      name: secret.name,
      encrypted_value: encryptedValue,
      key_id: publicKeyId
    })
  });

})().catch(console.log);