import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';

const pk = process.env.POLY_PRIVATE_KEY;
const host = process.env.POLY_CLOB_HOST || 'https://clob.polymarket.com';
const chainId = parseInt(process.env.POLY_CHAIN_ID || '137');

const wallet = new ethers.Wallet(pk);
console.log('EOA:', wallet.address);

function createClobSigner(w) {
  return {
    getAddress: () => Promise.resolve(w.address),
    _signTypedData: (domain, types, value) => w.signTypedData(domain, types, value)
  };
}
const signer = createClobSigner(wallet);

(async () => {
  const tempClient = new ClobClient(host, chainId, signer, undefined, 0, undefined);
  let creds;
  try {
    creds = await tempClient.deriveApiKey();
    console.log('API Key derived:', creds?.apiKey?.slice(0,8) + '...');
  } catch(e) {
    console.log('deriveApiKey error:', e.message);
    process.exit(1);
  }

  try {
    const c0 = new ClobClient(host, chainId, signer, creds, 0, undefined);
    const b0 = await c0.getBalanceAllowance({ asset_type: 'COLLATERAL', signature_type: 0 });
    console.log('Balance type=0 (EOA):', JSON.stringify(b0));
  } catch(e) { console.log('Balance type=0 error:', e.message); }

  try {
    const c1 = new ClobClient(host, chainId, signer, creds, 1, undefined);
    const b1 = await c1.getBalanceAllowance({ asset_type: 'COLLATERAL', signature_type: 1 });
    console.log('Balance type=1 (no funder):', JSON.stringify(b1));
  } catch(e) { console.log('Balance type=1 error:', e.message); }

  try {
    const c1f = new ClobClient(host, chainId, signer, creds, 1, wallet.address);
    const b1f = await c1f.getBalanceAllowance({ asset_type: 'COLLATERAL', signature_type: 1 });
    console.log('Balance type=1 (funder=EOA):', JSON.stringify(b1f));
  } catch(e) { console.log('Balance type=1 funder error:', e.message); }
})();
