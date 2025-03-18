import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

async function main() {
  // Configure the client
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  console.log("Program ID:", program.programId.toString());

  // Get command line arguments
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(
      "Usage: ts-node liquidate-margin-account.ts <ACCOUNT_OWNER_PUBKEY> [TOKEN_TYPE]"
    );
    console.error("TOKEN_TYPE can be 'SOL' or 'USDC', defaults to 'SOL'");
    process.exit(1);
  }

  const accountOwner = new PublicKey(args[0]);
  const tokenType = args[1]?.toUpperCase() || "SOL";

  if (tokenType !== "SOL" && tokenType !== "USDC") {
    console.error("TOKEN_TYPE must be either 'SOL' or 'USDC'");
    process.exit(1);
  }

  // Derive the margin account PDA for the target user
  const [marginAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_account"), accountOwner.toBuffer()],
    program.programId
  );

  // Derive the margin vault PDA
  const [marginVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_vault")],
    program.programId
  );

  // First fetch the margin vault account data
  const marginVaultAccount = await program.account.marginVault.fetch(
    marginVault
  );

  // Fetch the margin account to check if it has a balance to liquidate
  const marginAccountData = await program.account.marginAccount.fetch(
    marginAccount
  );

  console.log("SOL Balance:", marginAccountData.solBalance.toString());
  console.log("USDC Balance:", marginAccountData.usdcBalance.toString());

  // Then use the stored vault addresses based on which token we're liquidating
  const marginVaultTokenAccount =
    tokenType === "SOL"
      ? marginVaultAccount.solVault
      : marginVaultAccount.usdcVault;

  // Get the liquidity pool program ID
  const liquidityPoolProgramId = new PublicKey(
    process.env.LIQUIDITY_POOL_PROGRAM_ID!
  );

  // Get the pool state PDA
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    liquidityPoolProgramId
  );

  console.log("Pool state PDA:", poolState.toString());

  // Fetch the pool state to get the correct vault
  const perpAmmProgram = anchor.workspace.PerpAmm;
  const poolStateAccount = await perpAmmProgram.account.poolState.fetch(
    poolState
  );

  // Select the correct pool vault based on token type
  const poolVaultAccount =
    tokenType === "SOL"
      ? poolStateAccount.solVault
      : poolStateAccount.usdcVault;

  console.log("Liquidating margin account:", marginAccount.toString());
  console.log("Account owner:", accountOwner.toString());
  console.log("Token type being liquidated:", tokenType);
  console.log(
    "Margin vault token account:",
    marginVaultTokenAccount.toString()
  );
  console.log("Pool vault account:", poolVaultAccount.toString());

  try {
    await program.methods
      .liquidateMarginAccount()
      .accountsStrict({
        authority: provider.wallet.publicKey,
        marginAccount: marginAccount,
        marginVault: marginVault,
        marginVaultTokenAccount: marginVaultTokenAccount,
        poolState: poolState,
        poolVaultAccount: poolVaultAccount,
        chainlinkProgram: new PublicKey(process.env.CHAINLINK_PROGRAM_ID!),
        chainlinkFeed: new PublicKey(process.env.SOL_PRICE_FEED!),
        tokenProgram: TOKEN_PROGRAM_ID,
        liquidityPoolProgram: liquidityPoolProgramId,
      })
      .rpc();

    console.log("Margin account liquidated successfully!");
  } catch (error) {
    console.error("Failed to liquidate margin account:", error);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
