# 1. Clone the project and install workspace dependencies
git clone https://github.com/swap-io/swap-core.git
cd swap-core
yarn install

# 2. Build the Anchor Program to generate IDL and TypeScript typings
anchor build

# 3. Synchronize the program address with your local keypair
anchor keys sync

# 4. Launch the local Solana Test Validator with Token-2022 support
solana-test-validator --reset --quiet &

# 5. Execute the integration test suite
anchor test --skip-local-validator