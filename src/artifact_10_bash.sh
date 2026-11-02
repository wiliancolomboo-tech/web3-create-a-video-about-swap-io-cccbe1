# Configure Solana CLI for Devnet
solana config set --url https://api.devnet.solana.com

# Airdrop initial SOL for deployment keypair
solana airdrop 2

# Deploy protocol to Devnet
anchor deploy --provider.cluster devnet