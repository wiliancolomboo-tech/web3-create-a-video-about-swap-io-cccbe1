# 1. Start a local Solana validator with Token-2022 enabled
solana-test-validator --reset --quiet &

# 2. Run the full Mocha QA test suite
anchor test --skip-local-validator