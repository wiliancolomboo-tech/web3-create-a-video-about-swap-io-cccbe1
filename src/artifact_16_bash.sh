# 1. Configure CLI to Devnet
solana config set --url devnet

# 2. Airdrop SOL for deployment fees
solana airdrop 2

# 3. Synchronize program ID with your deployed keypair
anchor keys sync

# 4. Build and deploy
anchor build
anchor deploy --provider.cluster devnet