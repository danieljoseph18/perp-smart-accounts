import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PerpAmm } from "../target/types/perp_amm";
import { PerpMarginAccounts } from "../target/types/perp_margin_accounts";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as dotenv from "dotenv";

dotenv.config();

// -------------------------
// Constants & Chainlink IDs
// -------------------------
const CHAINLINK_PROGRAM_ID = new PublicKey(
  "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"
);
const CHAINLINK_SOL_FEED = process.env.IS_DEVNET
  ? new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR")
  : new PublicKey("CH31Xns5z3M1cTAbKW34jcxPPciazARpijcHj9rxtemt");

const WITHDRAWAL_TIMELOCK = 1; // seconds

// -------------------------
// Helper: Get or create USDC mint
// -------------------------
async function getUsdcMint(): Promise<PublicKey> {
  const isDevnet = process.env.IS_DEVNET === "true";
  console.log("IS_DEVNET:", isDevnet);
  if (isDevnet) {
    // Use a fixed devnet USDC mint if indicated.
    return new PublicKey("7ggkvgP7jijLpQBV5GXcqugTMrc2JqDi9tiCH36SVg7A");
  } else {
    return new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  }
}

// -------------------------
// Check if account exists
// -------------------------
async function accountExists(
  connection: anchor.web3.Connection,
  pubkey: PublicKey
): Promise<boolean> {
  const accountInfo = await connection.getAccountInfo(pubkey);
  return accountInfo !== null;
}

// -------------------------
// Initialize Margin Program
// -------------------------
async function initializeMarginProgram(
  provider: anchor.AnchorProvider,
  program: Program<PerpMarginAccounts>,
  solMint: PublicKey,
  usdcMint: PublicKey,
  chainlinkProgram: PublicKey,
  chainlinkFeed: PublicKey,
  admin: Keypair
) {
  console.log("\n=== Initializing Margin Program ===");

  // Derive the PDA for the margin vault using seed "margin_vault"
  const [marginVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_vault")],
    program.programId
  );

  console.log("Margin Vault PDA:", marginVault.toString());

  // Check if the margin vault account already exists
  const vaultExists = await accountExists(provider.connection, marginVault);
  if (vaultExists) {
    console.log("✓ Margin vault already exists, skipping initialization");

    // We still need the token accounts for the return value
    const solVaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      solMint,
      marginVault,
      true
    );
    const usdcVaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      marginVault,
      true
    );

    console.log(
      "Margin Program SOL Vault:",
      solVaultAccount.address.toString()
    );
    console.log(
      "Margin Program USDC Vault:",
      usdcVaultAccount.address.toString()
    );

    return {
      marginVault,
      marginSolVault: solVaultAccount.address,
      marginUsdcVault: usdcVaultAccount.address,
      chainlinkProgram,
      chainlinkFeed,
    };
  }

  // Create associated token accounts for the vault (with the PDA as owner)
  console.log("Creating margin program vault token accounts...");
  const solVaultAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    admin, // payer & signer
    solMint,
    marginVault,
    true
  );

  console.log("Margin Program SOL Vault:", solVaultAccount.address.toString());

  const usdcVaultAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    admin,
    usdcMint,
    marginVault,
    true
  );

  console.log(
    "Margin Program USDC Vault:",
    usdcVaultAccount.address.toString()
  );

  try {
    await program.methods
      .initialize(new BN(WITHDRAWAL_TIMELOCK), chainlinkProgram, chainlinkFeed)
      .accountsStrict({
        authority: admin.publicKey,
        marginVault,
        marginSolVault: solVaultAccount.address,
        marginUsdcVault: usdcVaultAccount.address,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    console.log("✓ Margin program initialized successfully!");

    return {
      marginVault,
      marginSolVault: solVaultAccount.address,
      marginUsdcVault: usdcVaultAccount.address,
      chainlinkProgram,
      chainlinkFeed,
    };
  } catch (error) {
    console.error("Failed to initialize margin program:", error);
    throw error;
  }
}

// -------------------------
// Initialize Perp AMM Program
// -------------------------
async function initializePerpAmm(
  provider: anchor.AnchorProvider,
  program: Program<PerpAmm>,
  marginProgramId: PublicKey,
  usdcMint: PublicKey
) {
  console.log("\n=== Initializing Perp AMM Program ===");

  // For AMM we use the wrapped SOL mint (it never changes)
  const solMint = new PublicKey("So11111111111111111111111111111111111111112");

  // Derive the pool state PDA using seed "pool_state"
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    program.programId
  );
  console.log("Pool State PDA:", poolState.toString());

  // Check if pool state account already exists
  const poolExists = await accountExists(provider.connection, poolState);
  if (poolExists) {
    console.log("✓ Perp AMM pool already exists, skipping initialization");

    // Still need to get the token accounts and LP mint for the return value
    const solVaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      solMint,
      poolState,
      true
    );
    const usdcVaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      poolState,
      true
    );

    console.log("Pool State SOL Vault:", solVaultAccount.address.toString());
    console.log("Pool State USDC Vault:", usdcVaultAccount.address.toString());

    // For LP token mint, we need to fetch it from the pool state data
    try {
      const poolData = await program.account.poolState.fetch(poolState);
      console.log("LP Token Mint:", poolData.lpTokenMint.toString());

      return {
        poolState,
        solVault: solVaultAccount.address,
        usdcVault: usdcVaultAccount.address,
        lpTokenMint: poolData.lpTokenMint,
      };
    } catch (error) {
      console.error("Error fetching pool state data:", error);
      throw error;
    }
  }

  // Derive PDAs for the vaults
  const [solVaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("sol_vault"), poolState.toBuffer()],
    program.programId
  );
  const solVault = solVaultPDA;

  const [usdcVaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("usdc_vault"), poolState.toBuffer()],
    program.programId
  );
  const usdcVault = usdcVaultPDA;

  const [usdcRewardVaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("usdc_reward_vault"), poolState.toBuffer()],
    program.programId
  );
  const usdcRewardVault = usdcRewardVaultPDA;

  console.log("Pool State SOL Vault:", solVault.toString());
  console.log("Pool State USDC Vault:", usdcVault.toString());

  // Create a keypair for the LP token mint
  const lpTokenMintKeypair = Keypair.generate();
  const lpTokenMint = lpTokenMintKeypair.publicKey;
  console.log("LP Token Mint:", lpTokenMint.toString());

  try {
    // Initialize Perp AMM program
    await program.methods
      .initialize()
      .accountsStrict({
        admin: provider.wallet.publicKey,
        poolState,
        solVault: solVault,
        usdcVault: usdcVault,
        solMint: solMint,
        usdcMint: usdcMint,
        usdcRewardVault: usdcRewardVault,
        lpTokenMint,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([provider.wallet.payer])
      .rpc();

    console.log(
      `✓ Pool state initialized successfully! ${poolState.toString()}`
    );

    // Initialize SOL vault
    await program.methods
      .initializeTokenVault(Buffer.from("sol_vault"))
      .accountsStrict({
        admin: provider.wallet.publicKey,
        poolState,
        vault: solVault,
        mint: solMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([provider.wallet.payer])
      .rpc();

    console.log(`✓ SOL vault initialized successfully! ${solVault.toString()}`);

    // Initialize USDC vault
    await program.methods
      .initializeTokenVault(Buffer.from("usdc_vault"))
      .accountsStrict({
        admin: provider.wallet.publicKey,
        poolState,
        vault: usdcVault,
        mint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([provider.wallet.payer])
      .rpc();

    console.log(
      `✓ USDC vault initialized successfully! ${usdcVault.toString()}`
    );

    // Initialize USDC reward vault
    await program.methods
      .initializeTokenVault(Buffer.from("usdc_reward_vault"))
      .accountsStrict({
        admin: provider.wallet.publicKey,
        poolState,
        vault: usdcRewardVault,
        mint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([provider.wallet.payer])
      .rpc();

    console.log(
      `✓ USDC reward vault initialized successfully! ${usdcRewardVault.toString()}`
    );

    // Initialize LP token mint
    await program.methods
      .initializeLpMint()
      .accountsStrict({
        admin: provider.wallet.publicKey,
        poolState,
        lpTokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([provider.wallet.payer, lpTokenMintKeypair])
      .rpc();

    console.log("✓ LP token mint initialized successfully!");

    // Add authorities to the pool state
    console.log("Adding authorities to pool state...");

    // Add the perp amm program as an authority for CPI calls
    await program.methods
      .addAuthority(program.programId)
      .accountsStrict({
        admin: provider.wallet.publicKey,
        poolState,
      })
      .signers([provider.wallet.payer])
      .rpc();

    console.log("✓ Added perp amm program as authority");

    // Add the admin as an authority
    await program.methods
      .addAuthority(provider.wallet.publicKey)
      .accountsStrict({
        admin: provider.wallet.publicKey,
        poolState,
      })
      .signers([provider.wallet.payer])
      .rpc();

    console.log("✓ Added admin as authority");

    return {
      poolState,
      solVault,
      usdcVault,
      lpTokenMint,
    };
  } catch (error) {
    console.error("Failed to initialize Perp AMM:", error);
    throw error;
  }
}

// -------------------------
// Main deployment function
// -------------------------
async function main() {
  console.log("Starting deployment process...");

  // Configure the provider with explicitly defined connection from .env
  const connection = new anchor.web3.Connection(
    process.env.ANCHOR_PROVIDER_URL!,
    "confirmed"
  );
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);

  // Use the provider wallet as the admin signer.
  const admin = (provider.wallet as anchor.Wallet).payer;

  // Use the wrapped SOL address (which is fixed).
  const solMint = new PublicKey("So11111111111111111111111111111111111111112");
  // Get or create the USDC mint (create a new one for localnet).
  const usdcMint = await getUsdcMint();

  // Get the program interfaces from the workspace.
  const marginProgram = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;
  const perpAmmProgram = anchor.workspace.PerpAmm as Program<PerpAmm>;

  console.log("Margin Program ID:", marginProgram.programId.toString());
  console.log("Perp AMM Program ID:", perpAmmProgram.programId.toString());
  console.log("Using RPC URL:", process.env.ANCHOR_PROVIDER_URL);
  console.log("Sol Mint:", solMint.toString());
  console.log("USDC Mint:", usdcMint.toString());

  // Initialize the margin program (create the vaults, etc.)
  const marginAccounts = await initializeMarginProgram(
    provider,
    marginProgram,
    solMint,
    usdcMint,
    CHAINLINK_PROGRAM_ID,
    CHAINLINK_SOL_FEED,
    admin
  );
  // Initialize the Perp AMM program (create pool state, vaults, and LP token mint)
  const perpAmmAccounts = await initializePerpAmm(
    provider,
    perpAmmProgram,
    marginProgram.programId,
    usdcMint
  );

  // Print a deployment summary
  console.log("\n=== Deployment Summary ===");
  console.log("Margin Program:");
  console.log("- Margin Vault:", marginAccounts.marginVault.toString());
  console.log("- Margin SOL Vault:", marginAccounts.marginSolVault.toString());
  console.log(
    "- Margin USDC Vault:",
    marginAccounts.marginUsdcVault.toString()
  );
  console.log("Perp AMM Program:");
  console.log("- Pool State:", perpAmmAccounts.poolState.toString());
  console.log("- Pool SOL Vault:", perpAmmAccounts.solVault.toString());
  console.log("- Pool USDC Vault:", perpAmmAccounts.usdcVault.toString());
  console.log("- LP Token Mint:", perpAmmAccounts.lpTokenMint.toString());
}

main().catch((error) => {
  console.error("\nDeployment failed:", error);
  process.exit(1);
});
