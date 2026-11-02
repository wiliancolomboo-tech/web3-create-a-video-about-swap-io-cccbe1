# 1. Switch Solana CLI to Devnet
solana config set --url https://api.devnet.solana.com

# 2. Fund Deployer Keypair
solana airdrop 2

# 3. Deploy Swap.io Program to Devnet
anchor deploy --provider.cluster devnet

# 4. Initialize Production Pool via Anchor CLI Client
anchor run test --provider.cluster devnet