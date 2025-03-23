// Deploy script for Print3r contracts: perp-amm and perp-margin-accounts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpAmm } from "../target/types/perp_amm";
import { PerpMarginAccounts } from "../target/types/perp_margin_accounts";
import { 
  PublicKey, 
  Keypair,
  SystemProgram, 
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import { 
  TOKEN_PROGRAM_ID, 
  createMint, 
  getOrCreateAssociatedTokenAccount,
  mintTo,
  NATIVE_MINT
} from "@solana/spl-token";
import * as dotenv from "dotenv";

dotenv.config();

// Devnet SOL/USD Price Feed
const SOL_USD_DEVNET_FEED = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");
const WITHDRAWAL_TIMELOCK = 3600; // 1 hour in seconds for production

module.exports = async function (provider: anchor.AnchorProvider) {
  // Configure client to use the provider
  anchor.setProvider(provider);

  console.log("====== Print3r Contracts Deployment ======");
  
  // Get the deployed program instances
  const marginProgram = anchor.workspace.PerpMarginAccounts as Program<PerpMarginAccounts>;
  const ammProgram = anchor.workspace.PerpAmm as Program<PerpAmm>;
  
  // Admin keypair (for deployment operations)
  // In production, you should use a more secure way to manage this key
  const admin = Keypair.fromSecretKey(
    Buffer.from(
      JSON.parse(
        process.env.ADMIN_PRIVATE_KEY || 
        // Default to a fixed keypair for local testing
        JSON.stringify(Array.from(Array(32).fill(1)))
      )
    )
  );
  
  console.log("Admin pubkey:", admin.publicKey.toString());
  
  // Get or use provided chainlink program
  let chainlinkProgram: PublicKey;
  if (process.env.CHAINLINK_PROGRAM) {
    chainlinkProgram = new PublicKey(process.env.CHAINLINK_PROGRAM);
  } else {
    // Default to devnet chainlink program
    chainlinkProgram = new PublicKey("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
  }
  
  // Get or use provided chainlink feed
  let chainlinkFeed: PublicKey;
  if (process.env.CHAINLINK_FEED) {
    chainlinkFeed = new PublicKey(process.env.CHAINLINK_FEED);
  } else {
    // Default to devnet SOL/USD feed
    chainlinkFeed = SOL_USD_DEVNET_FEED;
  }
  
  console.log("Using Chainlink program:", chainlinkProgram.toString());
  console.log("Using Chainlink feed:", chainlinkFeed.toString());
  
  // Ensure admin has enough SOL for deployment
  await ensureMinimumBalance(admin.publicKey, 10 * LAMPORTS_PER_SOL);
  
  // Step 1: Create or derive necessary PDAs
  console.log("\n=== Deriving PDAs ===");
  
  // Derive the margin vault PDA
  const [marginVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_vault")],
    marginProgram.programId
  );
  
  console.log("Margin Vault PDA:", marginVault.toString());
  
  // Derive the pool state PDA
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    ammProgram.programId
  );
  
  console.log("Pool State PDA:", poolState.toString());
  
  // Step 2: Check if margin vault already exists
  console.log("\n=== Checking existing deployment state ===");
  
  let isMarginVaultInitialized = false;
  let isPoolStateInitialized = false;
  let marginSolVault: PublicKey;
  let marginUsdcVault: PublicKey;
  let solVault: PublicKey;
  let usdcVault: PublicKey;
  let lpTokenMint: PublicKey;
  let usdcMint: PublicKey;
  
  try {
    const marginVaultInfo = await provider.connection.getAccountInfo(marginVault);
    if (marginVaultInfo) {
      console.log("✅ Margin vault already initialized");
      isMarginVaultInitialized = true;
      
      // Get existing margin program configuration
      const marginVaultAccount = await marginProgram.account.marginVault.fetch(marginVault);
      marginSolVault = marginVaultAccount.marginSolVault;
      marginUsdcVault = marginVaultAccount.marginUsdcVault;
      
      console.log("- Margin SOL vault:", marginSolVault.toString());
      console.log("- Margin USDC vault:", marginUsdcVault.toString());
    }
  } catch (error) {
    console.log("Margin vault not initialized yet");
  }
  
  try {
    const poolStateInfo = await provider.connection.getAccountInfo(poolState);
    if (poolStateInfo) {
      console.log("✅ Pool state already initialized");
      isPoolStateInitialized = true;
      
      // Get existing pool configuration
      const poolStateAccount = await ammProgram.account.poolState.fetch(poolState);
      solVault = poolStateAccount.solVault;
      usdcVault = poolStateAccount.usdcVault;
      lpTokenMint = poolStateAccount.lpTokenMint;
      usdcMint = poolStateAccount.usdcMint;
      
      console.log("- SOL vault:", solVault.toString());
      console.log("- USDC vault:", usdcVault.toString());
      console.log("- LP token mint:", lpTokenMint.toString());
      console.log("- USDC mint:", usdcMint.toString());
    }
  } catch (error) {
    console.log("Pool state not initialized yet");
  }
  
  // If both components are already initialized, we're done
  if (isMarginVaultInitialized && isPoolStateInitialized) {
    console.log("\n✅ All contracts are already deployed and initialized");
    return;
  }
  
  // Step 3: Set up token mints if needed
  console.log("\n=== Setting up token mints ===");
  
  // Use wrapped SOL for SOL mint
  const solMint = NATIVE_MINT;
  
  // Create or use existing USDC mint
  if (!usdcMint) {
    if (process.env.USDC_MINT) {
      // Use provided USDC mint
      usdcMint = new PublicKey(process.env.USDC_MINT);
      console.log("Using provided USDC mint:", usdcMint.toString());
    } else {
      // Create a new USDC mint for testing
      console.log("Creating new USDC mint...");
      usdcMint = await createMint(
        provider.connection,
        admin,
        admin.publicKey,
        null,
        6 // 6 decimals for USDC
      );
      console.log("Created USDC mint:", usdcMint.toString());
    }
  }
  
  // Step 4: Set up admin token accounts
  console.log("\n=== Setting up admin token accounts ===");
  
  const adminSolAccount = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      solMint,
      admin.publicKey
    )
  ).address;
  
  const adminUsdcAccount = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      admin.publicKey
    )
  ).address;
  
  console.log("Admin SOL account:", adminSolAccount.toString());
  console.log("Admin USDC account:", adminUsdcAccount.toString());
  
  // Step 5: Initialize Margin Program if needed
  if (!isMarginVaultInitialized) {
    console.log("\n=== Initializing Margin Program ===");
    
    // Create margin program token vaults
    const solVaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      solMint,
      marginVault,
      true
    );
    
    marginSolVault = solVaultAccount.address;
    console.log("Created margin SOL vault:", marginSolVault.toString());
    
    const usdcVaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      marginVault,
      true
    );
    
    marginUsdcVault = usdcVaultAccount.address;
    console.log("Created margin USDC vault:", marginUsdcVault.toString());
    
    // Initialize the margin vault
    console.log("Initializing margin vault...");
    await marginProgram.methods
      .initialize(
        new anchor.BN(WITHDRAWAL_TIMELOCK),
        chainlinkProgram,
        chainlinkFeed
      )
      .accountsStrict({
        authority: admin.publicKey,
        marginVault,
        marginSolVault,
        marginUsdcVault,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();
    
    console.log("✅ Margin Program initialized successfully!");
  }
  
  // Step 6: Initialize AMM Program if needed
  if (!isPoolStateInitialized) {
    console.log("\n=== Initializing AMM Program ===");
    
    // Create AMM program token vaults
    const ammSolVault = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      solMint,
      poolState,
      true
    );
    
    solVault = ammSolVault.address;
    console.log("Created AMM SOL vault:", solVault.toString());
    
    const ammUsdcVault = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      poolState,
      true
    );
    
    usdcVault = ammUsdcVault.address;
    console.log("Created AMM USDC vault:", usdcVault.toString());
    
    // Create LP token mint for the AMM
    const lpTokenMintKeypair = Keypair.generate();
    lpTokenMint = lpTokenMintKeypair.publicKey;
    console.log("Created LP token mint keypair:", lpTokenMint.toString());
    
    // Initialize the AMM program
    console.log("Initializing AMM program...");
    await ammProgram.methods
      .initialize()
      .accountsStrict({
        admin: admin.publicKey,
        authority: marginProgram.programId,
        poolState,
        solVault,
        usdcVault,
        usdcMint,
        usdcRewardVault: usdcVault, // Using same vault for rewards for simplicity
        lpTokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin, lpTokenMintKeypair])
      .rpc();
    
    console.log("✅ AMM Program initialized successfully!");
  }
  
  console.log("\n====== Deployment Complete ======");
  console.log("Margin Vault:", marginVault.toString());
  console.log("Pool State:", poolState.toString());
  console.log("SOL Mint:", solMint.toString());
  console.log("USDC Mint:", usdcMint.toString());
  console.log("LP Token Mint:", lpTokenMint.toString());
  
  // Helper function to ensure minimum SOL balance
  async function ensureMinimumBalance(address: PublicKey, minBalance: number) {
    const balance = await provider.connection.getBalance(address);
    if (balance < minBalance) {
      console.log(`Airdropping SOL to ${address.toString()}...`);
      try {
        const airdropTx = await provider.connection.requestAirdrop(
          address,
          minBalance - balance
        );
        await provider.connection.confirmTransaction(airdropTx);
        console.log("Airdrop successful");
      } catch (error) {
        console.warn("Airdrop failed - this is expected in production. Please ensure the account has enough SOL.");
      }
    }
  }
};