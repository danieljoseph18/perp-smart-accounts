import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpAmm } from "../target/types/perp_amm";
import { PerpMarginAccounts } from "../target/types/perp_margin_accounts";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Constants
const CHAINLINK_PROGRAM_ID = new PublicKey(
  "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"
);

const CHAINLINK_SOL_FEED = process.env.IS_DEVNET
  ? new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR")
  : new PublicKey("CH31Xns5z3M1cTAbKW34jcxPPciazARpijcHj9rxtemt");

const WITHDRAWAL_TIMELOCK = 5 * 60; // 5 minutes in seconds

async function initializeMarginProgram(
  provider: anchor.AnchorProvider,
  program: Program<PerpMarginAccounts>
) {
  console.log("\n=== Initializing Margin Program ===");

  // Set up token mints
  const solMint = new PublicKey("So11111111111111111111111111111111111111112");
  const usdcMint = process.env.IS_DEVNET
    ? new PublicKey("7ggkvgP7jijLpQBV5GXcqugTMrc2JqDi9tiCH36SVg7A")
    : new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  // Derive PDAs
  const [marginVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_vault")],
    program.programId
  );

  const [solVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("sol_vault")],
    program.programId
  );

  const [usdcVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("usdc_vault")],
    program.programId
  );

  console.log("Margin Vault PDA:", marginVault.toString());
  console.log("SOL Vault PDA:", solVault.toString());
  console.log("USDC Vault PDA:", usdcVault.toString());

  // Create token accounts for the vaults
  console.log("Creating vault token accounts...");
  const solVaultAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    solMint,
    marginVault,
    true
  );

  const usdcVaultAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    usdcMint,
    marginVault,
    true
  );

  console.log("SOL Vault Token Account:", solVaultAccount.address.toString());
  console.log("USDC Vault Token Account:", usdcVaultAccount.address.toString());

  try {
    await program.methods
      .initialize(
        new anchor.BN(WITHDRAWAL_TIMELOCK),
        CHAINLINK_PROGRAM_ID,
        CHAINLINK_SOL_FEED
      )
      .accountsStrict({
        authority: provider.wallet.publicKey,
        marginVault,
        solVault: solVaultAccount.address,
        usdcVault: usdcVaultAccount.address,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    console.log("✓ Margin program initialized successfully!");
    return {
      marginVault,
      solVault: solVaultAccount.address,
      usdcVault: usdcVaultAccount.address,
      chainlinkProgram: CHAINLINK_PROGRAM_ID,
      chainlinkFeed: CHAINLINK_SOL_FEED,
    };
  } catch (error) {
    console.error("Failed to initialize margin program:", error);
    throw error;
  }
}

async function initializePerpAmm(
  provider: anchor.AnchorProvider,
  program: Program<PerpAmm>,
  marginProgramId: PublicKey
) {
  console.log("\n=== Initializing Perp AMM Program ===");

  // Set up token mints
  const solMint = new PublicKey("So11111111111111111111111111111111111111112");
  const usdcMint = process.env.IS_DEVNET
    ? new PublicKey("7ggkvgP7jijLpQBV5GXcqugTMrc2JqDi9tiCH36SVg7A")
    : new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  // Find pool state PDA
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    program.programId
  );

  console.log("Pool State PDA:", poolState.toString());

  // Create vault accounts
  const solVault = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    solMint,
    poolState,
    true
  );

  const usdcVault = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    usdcMint,
    poolState,
    true
  );

  console.log("SOL Vault:", solVault.address.toString());
  console.log("USDC Vault:", usdcVault.address.toString());

  // Create LP token mint
  const lpTokenMintKeypair = Keypair.generate();
  await createMint(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    poolState,
    poolState,
    9,
    lpTokenMintKeypair
  );

  console.log("LP Token Mint:", lpTokenMintKeypair.publicKey.toString());

  try {
    await program.methods
      .initialize()
      .accountsStrict({
        admin: provider.wallet.publicKey,
        authority: marginProgramId,
        poolState,
        solVault: solVault.address,
        usdcVault: usdcVault.address,
        lpTokenMint: lpTokenMintKeypair.publicKey,
        usdcRewardVault: usdcVault.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([lpTokenMintKeypair])
      .rpc();

    console.log("✓ Perp AMM program initialized successfully!");
    return {
      poolState,
      solVault: solVault.address,
      usdcVault: usdcVault.address,
      lpTokenMint: lpTokenMintKeypair.publicKey,
    };
  } catch (error) {
    console.error("Failed to initialize Perp AMM:", error);
    throw error;
  }
}

async function main() {
  console.log("Starting deployment process...");

  // Configure the client
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Initialize both programs
  const marginProgram = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;
  const perpAmmProgram = anchor.workspace.PerpAmm as Program<PerpAmm>;

  console.log("Margin Program ID:", marginProgram.programId.toString());
  console.log("Perp AMM Program ID:", perpAmmProgram.programId.toString());

  // Initialize programs in sequence
  const marginAccounts = await initializeMarginProgram(provider, marginProgram);
  const perpAmmAccounts = await initializePerpAmm(
    provider,
    perpAmmProgram,
    marginProgram.programId
  );

  // Log all important addresses
  console.log("\n=== Deployment Summary ===");
  console.log("Margin Program:");
  console.log("- Margin Vault:", marginAccounts.marginVault.toString());
  console.log("- SOL Vault:", marginAccounts.solVault.toString());
  console.log("- USDC Vault:", marginAccounts.usdcVault.toString());
  console.log("\nPerp AMM Program:");
  console.log("- Pool State:", perpAmmAccounts.poolState.toString());
  console.log("- SOL Vault:", perpAmmAccounts.solVault.toString());
  console.log("- USDC Vault:", perpAmmAccounts.usdcVault.toString());
  console.log("- LP Token Mint:", perpAmmAccounts.lpTokenMint.toString());
}

main().catch((error) => {
  console.error("\nDeployment failed:", error);
  process.exit(1);
});
