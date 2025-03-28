import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { PerpAmm } from "../../target/types/perp_amm";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
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
  // Arguments: owner_pubkey pnl_update locked_sol locked_usdc sol_fees_owed usdc_fees_owed
  const args = process.argv.slice(2);
  if (args.length < 6) {
    console.log(
      "Usage: ts-node execute-withdraw.ts <owner_public_key> <pnl_update> <locked_sol> <locked_usdc> <sol_fees_owed> <usdc_fees_owed>"
    );
    console.log(
      "Example: ts-node execute-withdraw.ts Aa1CeQKW8UJpXafJLQJXXCUqzxRwJKUJyeQst73xpTTK 0 0 0 0 0"
    );
    process.exit(1);
  }

  const ownerPublicKey = new PublicKey(args[0]);
  const pnlUpdate = new BN(args[1]);
  const lockedSol = new BN(args[2]);
  const lockedUsdc = new BN(args[3]);
  const solFeesOwed = new BN(args[4]);
  const usdcFeesOwed = new BN(args[5]);

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
  const marginSolVault = marginVaultData.marginSolVault;
  const marginUsdcVault = marginVaultData.marginUsdcVault;

  // Fetch pool state to get vault addresses
  const poolStateData = await ammProgram.account.poolState.fetch(poolState);
  const solVault = poolStateData.solVault;
  const usdcVault = poolStateData.usdcVault;

  // Fetch margin account to determine which vault account to use
  const marginAccountData = await marginProgram.account.marginAccount.fetch(
    marginAccount
  );

  // Determine which vault to use based on which token has a pending withdrawal
  let poolVaultAccount;
  if (marginAccountData.pendingSolWithdrawal.gt(new BN(0))) {
    poolVaultAccount = solVault;
  } else {
    poolVaultAccount = usdcVault;
  }

  try {
    // Get the user token accounts
    const userSolAccount = await anchor.utils.token.associatedAddress({
      mint: new PublicKey("So11111111111111111111111111111111111111112"),
      owner: ownerPublicKey,
    });

    // Get USDC mint from margin vault
    const usdcMint = poolStateData.usdcMint;
    const userUsdcAccount = await anchor.utils.token.associatedAddress({
      mint: usdcMint,
      owner: ownerPublicKey,
    });

    console.log(
      `Executing withdrawal for account: ${marginAccount.toString()}`
    );
    console.log(`PnL update: ${pnlUpdate.toString()}`);
    console.log(`Locked SOL: ${lockedSol.toString()}`);
    console.log(`Locked USDC: ${lockedUsdc.toString()}`);
    console.log(`SOL fees: ${solFeesOwed.toString()}`);
    console.log(`USDC fees: ${usdcFeesOwed.toString()}`);

    // Call the execute withdrawal instruction
    const tx = await marginProgram.methods
      .executeWithdrawal(
        pnlUpdate,
        lockedSol,
        lockedUsdc,
        solFeesOwed,
        usdcFeesOwed
      )
      .accountsStrict({
        marginAccount: marginAccount,
        marginVault: marginVault,
        marginSolVault: marginSolVault,
        marginUsdcVault: marginUsdcVault,
        userSolAccount: userSolAccount,
        userUsdcAccount: userUsdcAccount,
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
    console.log(`Executed withdrawal for account: ${marginAccount.toString()}`);
  } catch (error) {
    console.error(`Error executing withdrawal:`, error);
  }
}

main().catch((error) => {
  console.error("Script failed:", error);
  process.exit(1);
});
