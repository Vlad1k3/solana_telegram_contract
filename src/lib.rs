//! # Solana Escrow Program
//! 
//! This program implements a secure escrow system for SOL and SPL token transactions
//! between two parties with an optional arbiter for dispute resolution.
//! 
//! ## Features
//! - Support for both SOL and SPL token escrows
//! - Three-party system: buyer, seller, and arbiter
//! - Multiple confirmation flows for secure transactions
//! - Mutual cancellation support
//! - PDA-based vault system for secure fund storage
//!
//! ## Security
//! - All account ownership validations
//! - PDA verification for vault accounts
//! - Overflow protection on arithmetic operations
//! - No unsafe code

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

mod state;
mod instructions;
mod utils;

use state::{EscrowAccount, EscrowState};
use instructions::EscrowInstruction;
use utils::{TokenTransfer, ValidationHelper, AccountHelper};

/// Service fee for creating an order (0.01 SOL in lamports)
const SERVICE_FEE: u64 = 10_000_000;

entrypoint!(process_instruction);

/// Main program entrypoint
fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    
    let instruction = EscrowInstruction::from_u8(instruction_data[0])?;
    
    match instruction {
        EscrowInstruction::CreateOffer => create_offer(program_id, accounts, instruction_data),
        EscrowInstruction::JoinOffer => join_offer(program_id, accounts, instruction_data),
        EscrowInstruction::FundEscrow => fund_escrow(program_id, accounts),
        EscrowInstruction::ConfirmEscrow => confirm_escrow(program_id, accounts),
        EscrowInstruction::ArbiterConfirm => arbiter_confirm(program_id, accounts),
        EscrowInstruction::ArbiterCancel => arbiter_cancel(program_id, accounts),
        EscrowInstruction::CloseEscrow => close_escrow(program_id, accounts),
        EscrowInstruction::GetEscrowInfo => get_escrow_info(program_id, accounts),
        EscrowInstruction::MutualCancel => mutual_cancel(program_id, accounts),
        EscrowInstruction::SellerConfirm => seller_confirm(program_id, accounts),
    }
}

/// Creates a new escrow offer
/// 
/// # Accounts
/// * `[signer]` initiator - Party creating the order (buyer or seller)
/// * `[writable]` escrow_account - PDA for storing order data
/// * `[writable]` vault - PDA for storing funds
/// * `[]` system_program - System program
/// * `[]` mint - SPL token mint (native mint for SOL)
/// * `[writable]` fee_collector - Service account for collecting fees
/// 
/// # Instruction Data
/// * byte 0: instruction type (0)
/// * byte 1: role (0 = buyer creates, 1 = seller creates)
/// * bytes 2-9: amount (u64, little-endian)
/// * bytes 10-41: arbiter pubkey (32 bytes)
/// * bytes 42-73: mint pubkey (32 bytes)
/// * bytes 74-105: fee_collector pubkey (32 bytes)
/// * bytes 106-137: random_seed for anonymity (32 bytes)
fn create_offer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    ValidationHelper::validate_instruction_data_length(instruction_data, 138, "CreateOffer")?;
    
    let role = instruction_data[1];
    let amount = u64::from_le_bytes(instruction_data[2..10].try_into().unwrap());
    let arbiter = Pubkey::new_from_array(instruction_data[10..42].try_into().unwrap());
    let mint = Pubkey::new_from_array(instruction_data[42..74].try_into().unwrap());
    let fee_collector = Pubkey::new_from_array(instruction_data[74..106].try_into().unwrap());
    let random_seed: [u8; 32] = instruction_data[106..138].try_into().unwrap();

    // Validate amount is not zero
    if amount == 0 {
        msg!("Amount must be greater than zero");
        return Err(ProgramError::InvalidInstructionData);
    }

    let accounts_iter = &mut accounts.iter();
    let initiator = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;
    let _mint_account = next_account_info(accounts_iter)?;
    let fee_collector_account = next_account_info(accounts_iter)?;

    // Validations
    ValidationHelper::validate_signer(initiator, "Initiator")?;
    ValidationHelper::validate_system_program(system_program)?;
    ValidationHelper::validate_fee_collector(fee_collector_account, &fee_collector)?;

    // Calculate vault PDA
    let (vault_pda, vault_bump) = Pubkey::find_program_address(
        &[b"vault", escrow_account.key.as_ref()],
        program_id,
    );
    if vault_pda != *vault.key {
        msg!("Invalid vault PDA");
        return Err(ProgramError::InvalidSeeds);
    }

    let rent = Rent::get()?;
    let escrow_rent = rent.minimum_balance(EscrowAccount::LEN);
    let vault_rent = rent.minimum_balance(0);

    // Calculate total cost with overflow protection
    let total_cost = SERVICE_FEE
        .checked_add(escrow_rent)
        .and_then(|x| x.checked_add(vault_rent))
        .ok_or(ProgramError::ArithmeticOverflow)?;

    ValidationHelper::validate_sufficient_balance(initiator, total_cost, "escrow creation")?;

    // Transfer service fee
    invoke(
        &system_instruction::transfer(initiator.key, fee_collector_account.key, SERVICE_FEE),
        &[initiator.clone(), fee_collector_account.clone(), system_program.clone()],
    )?;
    msg!("Service fee {} lamports transferred to {}", SERVICE_FEE, fee_collector);

    // Create escrow account if not exists
    if escrow_account.lamports() == 0 {
        let escrow_bump = ValidationHelper::validate_escrow_pda_with_seed(
            escrow_account, 
            &random_seed, 
            program_id
        )?;
        AccountHelper::create_pda_account(
            initiator,
            escrow_account,
            system_program,
            program_id,
            &[b"escrow", &random_seed, &[escrow_bump]],
            EscrowAccount::LEN as u64,
            escrow_rent,
        )?;
    }

    // Set roles based on who creates the offer
    let (buyer, seller) = if role == 0 {
        (*initiator.key, Pubkey::default())
    } else {
        (Pubkey::default(), *initiator.key)
    };

    let escrow_data = EscrowAccount {
        buyer,
        seller,
        arbiter,
        amount,
        state: EscrowState::Created as u8,
        vault_bump,
        mint,
        fee_collector,
    };

    // Create vault account if not exists
    if vault.lamports() == 0 {
        AccountHelper::create_pda_account(
            initiator,
            vault,
            system_program,
            program_id,
            &[b"vault", escrow_account.key.as_ref(), &[vault_bump]],
            0,
            vault_rent,
        )?;
    }

    escrow_data.save_to_account(escrow_account)?;
    
    msg!("Offer created successfully");
    msg!("Arbiter: {}", arbiter);
    msg!("Role: {}", if role == 0 { "buyer" } else { "seller" });
    msg!("Amount: {} lamports", amount);
    msg!("State: Created");
    
    Ok(())
}

/// Allows the second party to join an existing escrow offer
fn join_offer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    ValidationHelper::validate_instruction_data_length(instruction_data, 34, "JoinOffer")?;
    
    let role = instruction_data[1];
    let joiner = Pubkey::new_from_array(instruction_data[2..34].try_into().unwrap());

    let accounts_iter = &mut accounts.iter();
    let joiner_acc = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;

    // Validations
    ValidationHelper::validate_signer(joiner_acc, "Joiner")?;
    ValidationHelper::validate_account_key(joiner_acc, &joiner, "Joiner")?;
    ValidationHelper::validate_program_account(escrow_account, program_id, "escrow_account")?;

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    
    if escrow_data.get_state()? != EscrowState::Created {
        msg!("Offer must be in Created state");
        return Err(ProgramError::InvalidAccountData);
    }

    // Set the missing role
    if role == 0 {
        if escrow_data.buyer != Pubkey::default() {
            msg!("Buyer already set");
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        escrow_data.buyer = joiner;
    } else {
        if escrow_data.seller != Pubkey::default() {
            msg!("Seller already set");
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        escrow_data.seller = joiner;
    }

    escrow_data.set_state(EscrowState::Initialized);
    escrow_data.save_to_account(escrow_account)?;
    
    msg!("Offer joined by {}: {}", if role == 0 { "buyer" } else { "seller" }, joiner);
    msg!("State: Initialized");
    
    Ok(())
}

/// Allows the buyer to fund the escrow with the agreed amount
fn fund_escrow(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let buyer = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;
    let _mint_account = next_account_info(accounts_iter).ok();
    let buyer_token_account = next_account_info(accounts_iter).ok();
    let vault_token_account = next_account_info(accounts_iter).ok();
    let token_program = next_account_info(accounts_iter).ok();

    // Validations
    ValidationHelper::validate_signer(buyer, "Buyer")?;
    ValidationHelper::validate_program_account(escrow_account, program_id, "escrow_account")?;

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    
    if escrow_data.get_state()? != EscrowState::Initialized {
        msg!("Escrow must be in Initialized state");
        return Err(ProgramError::InvalidAccountData);
    }

    ValidationHelper::validate_vault_pda(vault, escrow_account.key, program_id, escrow_data.vault_bump)?;
    ValidationHelper::validate_participant(&escrow_data, buyer.key, "buyer")?;

    if TokenTransfer::is_native_mint(&escrow_data.mint) {
        ValidationHelper::validate_system_program(system_program)?;
        invoke(
            &system_instruction::transfer(buyer.key, vault.key, escrow_data.amount),
            &[buyer.clone(), vault.clone(), system_program.clone()],
        )?;
    } else {
        let buyer_token_account = buyer_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
        let vault_token_account = vault_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
        let token_program = token_program.ok_or(ProgramError::NotEnoughAccountKeys)?;
        
        TokenTransfer::transfer_spl_token(
            buyer_token_account,
            vault_token_account,
            buyer,
            token_program,
            escrow_data.amount,
            None,
        )?;
    }

    escrow_data.set_state(EscrowState::Funded);
    escrow_data.save_to_account(escrow_account)?;
    
    msg!("Escrow funded successfully. Amount: {} lamports", escrow_data.amount);
    msg!("State: Funded");
    
    Ok(())
}

/// Allows the seller to confirm they have fulfilled their obligations
fn seller_confirm(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let seller = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;

    // Validations
    ValidationHelper::validate_signer(seller, "Seller")?;
    ValidationHelper::validate_program_account(escrow_account, program_id, "escrow_account")?;
    
    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    
    if escrow_data.get_state()? != EscrowState::Funded {
        msg!("Escrow must be in Funded state");
        return Err(ProgramError::InvalidAccountData);
    }
    
    ValidationHelper::validate_participant(&escrow_data, seller.key, "seller")?;
    
    escrow_data.set_state(EscrowState::SellerConfirmed);
    escrow_data.save_to_account(escrow_account)?;
    
    msg!("Seller confirmed fulfillment");
    msg!("State: SellerConfirmed");
    
    Ok(())
}

/// Allows the buyer to confirm and release funds to seller
fn confirm_escrow(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let buyer = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let _system_program = next_account_info(accounts_iter)?;
    let seller_account = next_account_info(accounts_iter)?;
    let _mint_account = next_account_info(accounts_iter).ok();
    let vault_token_account = next_account_info(accounts_iter).ok();
    let seller_token_account = next_account_info(accounts_iter).ok();
    let token_program = next_account_info(accounts_iter).ok();

    // Validations
    ValidationHelper::validate_signer(buyer, "Buyer")?;
    ValidationHelper::validate_program_account(escrow_account, program_id, "escrow_account")?;
    
    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    
    if escrow_data.get_state()? != EscrowState::SellerConfirmed {
        msg!("Escrow must be in SellerConfirmed state");
        return Err(ProgramError::InvalidAccountData);
    }
    
    ValidationHelper::validate_vault_pda(vault, escrow_account.key, program_id, escrow_data.vault_bump)?;
    ValidationHelper::validate_participant(&escrow_data, buyer.key, "buyer")?;
    ValidationHelper::validate_account_key(seller_account, &escrow_data.seller, "seller")?;

    // Transfer funds to seller
    if TokenTransfer::is_native_mint(&escrow_data.mint) {
        TokenTransfer::transfer_sol(vault, seller_account, escrow_data.amount)?;
    } else {
        let vault_token_account = vault_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
        let seller_token_account = seller_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
        let token_program = token_program.ok_or(ProgramError::NotEnoughAccountKeys)?;
        
        TokenTransfer::transfer_spl_token(
            vault_token_account,
            seller_token_account,
            vault,
            token_program,
            escrow_data.amount,
            Some(&[b"vault", escrow_account.key.as_ref(), &[escrow_data.vault_bump]]),
        )?;
    }

    escrow_data.set_state(EscrowState::Completed);
    escrow_data.save_to_account(escrow_account)?;
    
    msg!("Escrow confirmed by buyer. Funds released to seller");
    msg!("State: Completed");
    
    Ok(())
}

/// Arbiter confirms escrow, funds go to seller
fn arbiter_confirm(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let arbiter = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let seller = next_account_info(accounts_iter)?;
    let _mint_account = next_account_info(accounts_iter).ok();
    let vault_token_account = next_account_info(accounts_iter).ok();
    let seller_token_account = next_account_info(accounts_iter).ok();
    let token_program = next_account_info(accounts_iter).ok();

    // Validations
    ValidationHelper::validate_signer(arbiter, "Arbiter")?;
    ValidationHelper::validate_program_account(escrow_account, program_id, "escrow_account")?;

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;

    ValidationHelper::validate_vault_pda(vault, escrow_account.key, program_id, escrow_data.vault_bump)?;
    ValidationHelper::validate_participant(&escrow_data, arbiter.key, "arbiter")?;
    ValidationHelper::validate_account_key(seller, &escrow_data.seller, "seller")?;

    let state = escrow_data.get_state()?;
    if state != EscrowState::Funded && state != EscrowState::SellerConfirmed {
        msg!("Escrow must be in Funded or SellerConfirmed state");
        return Err(ProgramError::InvalidAccountData);
    }

    // Transfer funds to seller
    if TokenTransfer::is_native_mint(&escrow_data.mint) {
        TokenTransfer::transfer_sol(vault, seller, escrow_data.amount)?;
    } else {
        let vault_token_account = vault_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
        let seller_token_account = seller_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
        let token_program = token_program.ok_or(ProgramError::NotEnoughAccountKeys)?;
        
        TokenTransfer::transfer_spl_token(
            vault_token_account,
            seller_token_account,
            vault,
            token_program,
            escrow_data.amount,
            Some(&[b"vault", escrow_account.key.as_ref(), &[escrow_data.vault_bump]]),
        )?;
    }

    escrow_data.set_state(EscrowState::Completed);
    escrow_data.save_to_account(escrow_account)?;
    
    msg!("Escrow completed by arbiter. Funds released to seller");
    msg!("State: Completed");
    
    Ok(())
}

/// Arbiter cancels escrow, funds return to buyer
fn arbiter_cancel(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let arbiter = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let buyer = next_account_info(accounts_iter)?;
    let _mint_account = next_account_info(accounts_iter).ok();
    let vault_token_account = next_account_info(accounts_iter).ok();
    let buyer_token_account = next_account_info(accounts_iter).ok();
    let token_program = next_account_info(accounts_iter).ok();

    // Validations
    ValidationHelper::validate_signer(arbiter, "Arbiter")?;
    ValidationHelper::validate_program_account(escrow_account, program_id, "escrow_account")?;

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;

    ValidationHelper::validate_vault_pda(vault, escrow_account.key, program_id, escrow_data.vault_bump)?;
    ValidationHelper::validate_participant(&escrow_data, arbiter.key, "arbiter")?;
    ValidationHelper::validate_account_key(buyer, &escrow_data.buyer, "buyer")?;

    let state = escrow_data.get_state()?;
    if state != EscrowState::Funded && state != EscrowState::SellerConfirmed {
        msg!("Escrow must be in Funded or SellerConfirmed state");
        return Err(ProgramError::InvalidAccountData);
    }

    // Return funds to buyer
    if TokenTransfer::is_native_mint(&escrow_data.mint) {
        TokenTransfer::transfer_sol(vault, buyer, escrow_data.amount)?;
    } else {
        let vault_token_account = vault_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
        let buyer_token_account = buyer_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
        let token_program = token_program.ok_or(ProgramError::NotEnoughAccountKeys)?;
        
        TokenTransfer::transfer_spl_token(
            vault_token_account,
            buyer_token_account,
            vault,
            token_program,
            escrow_data.amount,
            Some(&[b"vault", escrow_account.key.as_ref(), &[escrow_data.vault_bump]]),
        )?;
    }

    escrow_data.set_state(EscrowState::Cancelled);
    escrow_data.save_to_account(escrow_account)?;
    
    msg!("Escrow cancelled by arbiter. Funds returned to buyer");
    msg!("State: Cancelled");
    
    Ok(())
}

/// Buyer and seller mutually cancel escrow
fn mutual_cancel(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let buyer = next_account_info(accounts_iter)?;
    let seller = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let _mint_account = next_account_info(accounts_iter).ok();
    let vault_token_account = next_account_info(accounts_iter).ok();
    let buyer_token_account = next_account_info(accounts_iter).ok();
    let token_program = next_account_info(accounts_iter).ok();

    // Both parties must sign
    if !buyer.is_signer || !seller.is_signer {
        msg!("Both buyer and seller must sign");
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    ValidationHelper::validate_program_account(escrow_account, program_id, "escrow_account")?;

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;

    ValidationHelper::validate_vault_pda(vault, escrow_account.key, program_id, escrow_data.vault_bump)?;
    ValidationHelper::validate_account_key(buyer, &escrow_data.buyer, "buyer")?;
    ValidationHelper::validate_account_key(seller, &escrow_data.seller, "seller")?;

    let state = escrow_data.get_state()?;
    if state != EscrowState::Initialized && state != EscrowState::Funded {
        msg!("Escrow can only be cancelled in Initialized or Funded state");
        return Err(ProgramError::InvalidAccountData);
    }

    // If funded, return funds to buyer
    if state == EscrowState::Funded {
        if TokenTransfer::is_native_mint(&escrow_data.mint) {
            TokenTransfer::transfer_sol(vault, buyer, escrow_data.amount)?;
        } else {
            let vault_token_account = vault_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
            let buyer_token_account = buyer_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
            let token_program = token_program.ok_or(ProgramError::NotEnoughAccountKeys)?;
            
            TokenTransfer::transfer_spl_token(
                vault_token_account,
                buyer_token_account,
                vault,
                token_program,
                escrow_data.amount,
                Some(&[b"vault", escrow_account.key.as_ref(), &[escrow_data.vault_bump]]),
            )?;
        }
    }

    escrow_data.set_state(EscrowState::Cancelled);
    escrow_data.save_to_account(escrow_account)?;
    
    msg!("Escrow mutually cancelled");
    msg!("State: Cancelled");
    
    Ok(())
}

/// Close escrow account, return rent to closer
fn close_escrow(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let closer = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter).ok();

    ValidationHelper::validate_signer(closer, "Closer")?;
    ValidationHelper::validate_program_account(escrow_account, program_id, "escrow_account")?;

    let escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;

    if !escrow_data.can_be_closed()? {
        msg!("Escrow must be completed or cancelled");
        return Err(ProgramError::InvalidAccountData);
    }

    if !escrow_data.is_participant(closer.key) {
        msg!("Closer must be participant or arbiter");
        return Err(ProgramError::IllegalOwner);
    }

    // Close escrow account - return all lamports
    let escrow_balance = escrow_account.lamports();
    **escrow_account.try_borrow_mut_lamports()? = 0;
    **closer.try_borrow_mut_lamports()? = closer
        .lamports()
        .checked_add(escrow_balance)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    // Zero out data
    let mut data = escrow_account.try_borrow_mut_data()?;
    data.fill(0);

    // Close vault if provided
    if let Some(vault) = vault {
        // Validate vault PDA
        if let Ok(()) = ValidationHelper::validate_vault_pda(
            vault, 
            escrow_account.key, 
            program_id, 
            escrow_data.vault_bump
        ) {
            let vault_balance = vault.lamports();
            if vault_balance > 0 {
                **vault.try_borrow_mut_lamports()? = 0;
                **closer.try_borrow_mut_lamports()? = closer
                    .lamports()
                    .checked_add(vault_balance)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
            }
        }
    }

    msg!("Escrow closed. {} lamports returned", escrow_balance);
    
    Ok(())
}

/// Get escrow information (for debugging)
fn get_escrow_info(_program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let escrow_account = next_account_info(accounts_iter)?;

    let escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    
    msg!("=== Escrow Information ===");
    msg!("State: {:?}", escrow_data.get_state()?);
    msg!("Amount: {} lamports", escrow_data.amount);
    msg!("Buyer: {}", escrow_data.buyer);
    msg!("Seller: {}", escrow_data.seller);
    msg!("Arbiter: {}", escrow_data.arbiter);
    msg!("Mint: {}", escrow_data.mint);
    msg!("Fee Collector: {}", escrow_data.fee_collector);
    msg!("Vault Bump: {}", escrow_data.vault_bump);
    msg!("==========================");
    
    Ok(())
}