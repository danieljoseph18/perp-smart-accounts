# Print3r Solana Contracts Guide

## Build/Test Commands
- Build: `anchor build`
- Deploy: `anchor deploy`
- All tests: `anchor test`
- Single test: `yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/amm-deposit.ts`
- AMM tests only: `yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/amm-*.ts`
- Margin tests only: `yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/margin-*.ts`

## Code Style
- **Rust**: Snake_case for variables/functions, CamelCase for types
- **TypeScript**: camelCase for variables, PascalCase for types/interfaces
- **Imports**: Group by standard lib, external crates, internal modules
- **Error handling**: Custom error enums with descriptive messages
- **Tests**: Mocha/Chai with describe/it blocks
- **Types**: Strong typing, BN.js for large numbers in TypeScript
- **Documentation**: Comments for function purposes, event definitions

## Project Structure
- Programs in separate dirs (`perp-amm`, `perp-margin-accounts`)
- Each program has instructions/ and state.rs
- Tests follow naming convention (amm-*.ts, margin-*.ts)