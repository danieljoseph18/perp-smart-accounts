import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { PerpAmm } from "../target/types/perp_amm";
import { PerpMarginAccounts } from "../target/types/perp_margin_accounts";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  if (process.argv.length < 3) {
    console.error("Usage: ts-node scripts/setAuthority.ts <authority_pubkey>");
    process.exit(1);
  }

  // Get new authority from command line
  const newAuthority = new PublicKey(process.argv[2]);
  console.log(`Adding authority: ${newAuthority.toString()}`);

  // Configure provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Get the wallet's public key (admin key)
  const adminKey = provider.wallet.publicKey;
  console.log(`Admin key: ${adminKey.toString()}`);

  // Load programs
  const marginProgram = anchor.workspace.PerpMarginAccounts as Program<PerpMarginAccounts>;
  const perpAmmProgram = anchor.workspace.PerpAmm as Program<PerpAmm>;

  console.log(`Margin Program ID: ${marginProgram.programId.toString()}`);
  console.log(`Perp AMM Program ID: ${perpAmmProgram.programId.toString()}`);

  // For perp-margin-accounts, fetch the marginVault
  const [marginVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("margin_vault")],
    marginProgram.programId
  );
  console.log(`Margin Vault: ${marginVault.toString()}`);

  // For perp-amm, fetch the poolState
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    perpAmmProgram.programId
  );
  console.log(`Pool State: ${poolState.toString()}`);

  try {
    // Fetch current margin vault data and add authority if needed
    const marginVaultData = await marginProgram.account.marginVault.fetch(marginVault);
    console.log(`Current margin program authorities: ${marginVaultData.authorities.map(a => a.toString()).join(", ")}`);
    
    if (marginVaultData.authorities.some((auth: PublicKey) => auth.equals(newAuthority))) {
      console.log(`✓ New authority is already in the authorities list for margin program`);
    } else {
      // Add the new authority
      await marginProgram.methods.addAuthority(newAuthority)
        .accounts({
          authority: provider.wallet.publicKey,
          marginVault
        })
        .rpc();
      
      console.log(`✅ Added new authority to margin program: ${newAuthority.toString()}`);
    }

    // Fetch current pool state data and add authority if needed
    const poolStateData = await perpAmmProgram.account.poolState.fetch(poolState);
    console.log(`Current AMM program authorities: ${poolStateData.authorities.map(a => a.toString()).join(", ")}`);
    
    if (poolStateData.authorities.some((auth: PublicKey) => auth.equals(newAuthority))) {
      console.log(`✓ New authority is already in the authorities list for AMM program`);
    } else {
      // Add the new authority
      await perpAmmProgram.methods.addAuthority(newAuthority)
        .accounts({
          admin: provider.wallet.publicKey,
          poolState
        })
        .rpc();
      
      console.log(`✅ Added new authority to AMM program: ${newAuthority.toString()}`);
    }

  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});