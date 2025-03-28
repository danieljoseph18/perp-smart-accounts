import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { PerpAmm } from "../../target/types/perp_amm";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as dotenv from "dotenv";

dotenv.config();

// Chainlink program and feed constants
const CHAINLINK_PROGRAM_ID = new PublicKey(
  process.env.CHAINLINK_PROGRAM_ID ||
    "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"
);

const CHAINLINK_SOL_FEED = process.env.CHAINLINK_SOL_FEED
  ? new PublicKey(process.env.CHAINLINK_SOL_FEED)
  : new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");

async function main() {
  // Configure the client to use the specified cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const marginProgram = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  const ammProgram = anchor.workspace.PerpAmm as Program<PerpAmm>;

  // Parse command line arguments
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("Usage: ts-node liquidate.ts <owner_public_key> <token_type>");
    console.log("token_type can be 'sol' or 'usdc'");
    console.log(
      "Example: ts-node liquidate.ts Aa1CeQKW8UJpXafJLQJXXCUqzxRwJKUJyeQst73xpTTK sol"
    );
    process.exit(1);
  }

  const ownerPublicKey = new PublicKey(args[0]);
  const tokenType = args[1].toLowerCase();

  if (tokenType !== "sol" && tokenType !== "usdc") {
    console.error("Token type must be 'sol' or 'usdc'");
    process.exit(1);
  }

  // Derive margin account PDA
  const [marginAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_account"), ownerPublicKey.toBuffer()],
    marginProgram.programId
  );

  // Derive margin vault PDA
  const [marginVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_vault")],
    marginProgram.programId
  );

  // Derive pool state PDA
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    ammProgram.programId
  );

  // Fetch margin vault details to get token accounts
  const marginVaultData = await marginProgram.account.marginVault.fetch(
    marginVault
  );

  // Fetch pool state to get vault addresses
  const poolStateData = await ammProgram.account.poolState.fetch(poolState);

  // Set the appropriate vault accounts based on token type
  const marginVaultTokenAccount =
    tokenType === "sol"
      ? marginVaultData.marginSolVault
      : marginVaultData.marginUsdcVault;

  const poolVaultAccount =
    tokenType === "sol" ? poolStateData.solVault : poolStateData.usdcVault;

  console.log(
    `Liquidating ${tokenType.toUpperCase()} for account: ${marginAccount.toString()}`
  );

  try {
    // Call the liquidate instruction
    const tx = await marginProgram.methods
      .liquidateMarginAccount()
      .accountsStrict({
        marginAccount: marginAccount,
        marginVault: marginVault,
        marginVaultTokenAccount: marginVaultTokenAccount,
        poolState: poolState,
        poolVaultAccount: poolVaultAccount,
        chainlinkProgram: CHAINLINK_PROGRAM_ID,
        chainlinkFeed: CHAINLINK_SOL_FEED,
        authority: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        liquidityPoolProgram: ammProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .signers([provider.wallet.payer])
      .rpc();

    console.log(`Transaction successful: ${tx}`);
    console.log(
      `Liquidated ${tokenType.toUpperCase()} for account: ${marginAccount.toString()}`
    );
  } catch (error) {
    console.error(`Error liquidating account:`, error);
  }
}

main().catch((error) => {
  console.error("Script failed:", error);
  process.exit(1);
});
