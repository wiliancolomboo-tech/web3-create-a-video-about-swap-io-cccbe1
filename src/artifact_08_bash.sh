# Terminal 1: Launch Localnet Validator with Token-2022 and SPL Token support
solana-test-validator --reset

# Terminal 2: Deploy program
solana program deploy target/deploy/swap_io_core.rs.so --program-id Swap1o1111111111111111111111111111111111111

# Monitor Logs
solana logs Swap1o1111111111111111111111111111111111111