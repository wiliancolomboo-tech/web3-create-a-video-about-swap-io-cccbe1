# 1. Install TypeScript dependencies
yarn install

# 2. Build the Anchor program to verify compilation & generate IDL
anchor build

# 3. Synchronize program keys
anchor keys sync

# 4. Run the complete test matrix on local test validator
anchor test