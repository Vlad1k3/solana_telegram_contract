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

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};
use spl_token;
use spl_token::solana_program::pubkey as spl_pubkey;

mod state;
mod instructions;
mod utils;

use state::{EscrowAccount, EscrowState};
use instructions::{EscrowInstruction};
use utils::{TokenTransfer, ValidationHelper, AccountHelper};

/// Комиссия сервиса за создание ордера (0.01 SOL в lamports)
const SERVICE_FEE: u64 = 10_000_000;


entrypoint!(process_instruction);

/// Main program entrypoint that dispatches instructions based on the first byte
/// of instruction data.
/// 
/// # Arguments
/// * `program_id` - The program ID
/// * `accounts` - Array of account infos required for the instruction
/// * `instruction_data` - Serialized instruction data
/// 
/// # Returns
/// * `ProgramResult` - Success or failure of the instruction execution
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

/// Создаёт новое предложение ордера, к которому может подключиться другая сторона.
/// При создании с инициатора списывается комиссия 0.01 SOL для fee payer.
/// 
/// # Аккаунты
/// * `[signer]` initiator - Сторона, создающая ордер (покупатель или продавец)
/// * `[writable]` escrow_account - PDA для хранения данных ордера
/// * `[writable]` vault - PDA для хранения средств
/// * `[]` system_program - Системная программа для создания аккаунтов
/// * `[]` mint - Минт SPL токена (нативный минт для SOL)
/// * `[writable]` fee_collector - Аккаунт сервиса для сбора комиссии
/// 
/// # Данные инструкции
/// * байт 0: тип инструкции (0)
/// * байт 1: роль (0 = покупатель создаёт, 1 = продавец создаёт)
/// * байты 2-9: сумма (u64, little-endian)
/// * байты 10-41: pubkey арбитра (32 байта)
/// * байты 42-73: pubkey минта (32 байта)
/// * байты 74-105: pubkey fee_collector (32 байта)
/// * байты 106-137: random_seed для анонимности (32 байта)
fn create_offer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    ValidationHelper::validate_instruction_data_length(instruction_data, 138, "CreateOffer")?; // 1 + 1 + 8 + 32 + 32 + 32 + 32
    
    let role = instruction_data[1];
    let amount = u64::from_le_bytes(instruction_data[2..10].try_into().unwrap());
    let arbiter = Pubkey::new_from_array(instruction_data[10..42].try_into().unwrap());
    let mint = Pubkey::new_from_array(instruction_data[42..74].try_into().unwrap());
    let fee_collector = Pubkey::new_from_array(instruction_data[74..106].try_into().unwrap());
    let random_seed: [u8; 32] = instruction_data[106..138].try_into().unwrap();

    let accounts_iter = &mut accounts.iter();
    let initiator = next_account_info(accounts_iter)?; // Buyer or seller
    let escrow_account = next_account_info(accounts_iter)?; // Escrow PDA
    let vault = next_account_info(accounts_iter)?; // Vault PDA or ATA
    let system_program = next_account_info(accounts_iter)?;
    let _mint_account = next_account_info(accounts_iter)?;
    let fee_collector_account = next_account_info(accounts_iter)?; // Аккаунт сервиса

    ValidationHelper::validate_signer(initiator, "Initiator")?;
    ValidationHelper::validate_fee_collector(fee_collector_account, &fee_collector)?;
    ValidationHelper::validate_sufficient_balance(initiator, SERVICE_FEE, "service fee payment")?;

    // Переводим комиссию сервиса (0.01 SOL) через system program
    invoke(
        &system_instruction::transfer(initiator.key, fee_collector_account.key, SERVICE_FEE),
        &[initiator.clone(), fee_collector_account.clone(), system_program.clone()],
    )?;
    msg!("Комиссия сервиса {} lamports переведена на {}", SERVICE_FEE, fee_collector);

    let (vault_pda, vault_bump) = Pubkey::find_program_address(
        &[b"vault", escrow_account.key.as_ref()],
        program_id,
    );
    if vault_pda != *vault.key {
        msg!("Invalid vault PDA");
        return Err(ProgramError::InvalidSeeds);
    }

    let rent = Rent::get()?;
    let required_lamports = rent.minimum_balance(EscrowAccount::LEN);

    if escrow_account.lamports() == 0 {
        let escrow_bump = ValidationHelper::validate_escrow_pda_with_seed(escrow_account, &random_seed, program_id)?;
        AccountHelper::create_pda_account(
            initiator,
            escrow_account,
            system_program,
            program_id,
            &[b"escrow", &random_seed, &[escrow_bump]],
            EscrowAccount::LEN as u64,
            required_lamports,
        )?;
    }

    // Set roles based on who creates the offer
    let (buyer, seller) = if role == 0 {
        (*initiator.key, Pubkey::default()) // Initiator is buyer
    } else {
        (Pubkey::default(), *initiator.key) // Initiator is seller
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
    
    let rent = Rent::get()?;
    // CRITICAL FIX: Правильно рассчитываем rent для vault аккаунта
    let vault_rent = rent.minimum_balance(0); // Для пустого аккаунта
    
    // Create vault account if not exists
    if vault.lamports() == 0 {
        // CRITICAL FIX: Проверяем, что у initiator достаточно средств для создания vault
        if initiator.lamports() < vault_rent {
            msg!("Insufficient funds to create vault account");
            return Err(ProgramError::InsufficientFunds);
        }
        
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
    msg!("Offer created with arbiter: {}", arbiter);
    msg!("Initiator role: {}", if role == 0 { "buyer" } else { "seller" });
    msg!("Mint: {}", mint);
    msg!("State: Created");
    Ok(())
}

/// Allows the second party to join an existing escrow offer.
/// 
/// # Accounts
/// * `[signer]` joiner - The party joining the offer
/// * `[writable]` escrow_account - Escrow PDA to update
/// 
/// # Instruction Data
/// * byte 0: instruction type (1)
/// * byte 1: role (0 = buyer joins, 1 = seller joins)
/// * bytes 2-33: joiner pubkey (32 bytes)
fn join_offer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    ValidationHelper::validate_instruction_data_length(instruction_data, 34, "JoinOffer")?;
    
    let role = instruction_data[1];
    let joiner = Pubkey::new_from_array(instruction_data[2..34].try_into().unwrap());

    let accounts_iter = &mut accounts.iter();
    let joiner_acc = next_account_info(accounts_iter)?; // Buyer or seller
    let escrow_account = next_account_info(accounts_iter)?; // Escrow PDA

    ValidationHelper::validate_signer(joiner_acc, "Joiner")?;
    
    // CRITICAL FIX: Проверяем, что joiner_acc соответствует переданному joiner
    if *joiner_acc.key != joiner {
        msg!("Joiner account key does not match provided joiner pubkey");
        return Err(ProgramError::InvalidAccountData);
    }

    // CRITICAL FIX: Проверяем, что escrow аккаунт принадлежит программе
    ValidationHelper::validate_program_account(escrow_account, program_id, "escrow_account")?;

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    
    if escrow_data.get_state()? != EscrowState::Created {
        msg!("Offer must be in Created state");
        return Err(ProgramError::InvalidAccountData);
    }

    // Set the missing role
    if role == 0 {
        // Joiner is buyer
        if escrow_data.buyer != Pubkey::default() {
            msg!("Buyer already set");
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        escrow_data.buyer = joiner;
    } else {
        // Joiner is seller
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

/// Allows the buyer to fund the escrow with the agreed amount.
/// 
/// # Accounts
/// * `[signer]` buyer - The buyer funding the escrow
/// * `[writable]` escrow_account - Escrow PDA
/// * `[writable]` vault - Vault PDA to receive funds
/// * `[]` system_program - System program for SOL transfers
/// * Additional accounts for SPL token transfers (optional)
fn fund_escrow(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let buyer = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;
    let _mint_account = next_account_info(accounts_iter).ok(); // optional for SOL
    let buyer_token_account = next_account_info(accounts_iter).ok(); // optional for SOL
    let vault_token_account = next_account_info(accounts_iter).ok(); // optional for SOL
    let token_program = next_account_info(accounts_iter).ok(); // optional for SOL

    ValidationHelper::validate_signer(buyer, "Buyer")?;
    
    // CRITICAL FIX: Проверяем, что escrow аккаунт принадлежит программе
    ValidationHelper::validate_program_account(escrow_account, program_id, "escrow_account")?;

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    if escrow_data.get_state()? != EscrowState::Initialized {
        msg!("Escrow must be in Initialized state");
        return Err(ProgramError::InvalidAccountData);
    }

    ValidationHelper::validate_vault_pda(vault, escrow_account.key, program_id, escrow_data.vault_bump)?;
    ValidationHelper::validate_participant(&escrow_data, buyer.key, "buyer")?;

    if TokenTransfer::is_native_mint(&escrow_data.mint) {
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
    msg!("Escrow funded successfully. State: Funded");
    Ok(())
}

/// Allows the seller to confirm they have fulfilled their obligations.
/// 
/// # Accounts
/// * `[signer]` seller - The seller confirming fulfillment
/// * `[writable]` escrow_account - Escrow PDA to update
fn seller_confirm(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let seller = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;

    ValidationHelper::validate_signer(seller, "Seller")?;
    
    // CRITICAL FIX: Проверяем, что escrow аккаунт принадлежит программе
    ValidationHelper::validate_program_account(escrow_account, program_id, "escrow_account")?;
    
    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    if escrow_data.get_state()? != EscrowState::Funded {
        msg!("Escrow must be in Funded state");
        return Err(ProgramError::InvalidAccountData);
    }
    ValidationHelper::validate_participant(&escrow_data, seller.key, "seller")?;
    escrow_data.set_state(EscrowState::SellerConfirmed);
    escrow_data.save_to_account(escrow_account)?;
    msg!("Seller confirmed fulfillment. State: SellerConfirmed");
    Ok(())
}

/// Allows the buyer to confirm the escrow and release funds to seller.
/// This can only be called after the seller has confirmed fulfillment.
/// 
/// # Accounts
/// * `[signer]` buyer - The buyer confirming the transaction
/// * `[writable]` escrow_account - Escrow PDA
/// * `[writable]` vault - Vault PDA holding the funds
/// * `[]` system_program - System program
/// * `[writable]` seller_account - Seller's account to receive funds
/// * Additional accounts for SPL token transfers (optional)
fn confirm_escrow(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let buyer = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;
    let seller_account = next_account_info(accounts_iter)?;
    let _mint_account = next_account_info(accounts_iter).ok();
    let vault_token_account = next_account_info(accounts_iter).ok();
    let seller_token_account = next_account_info(accounts_iter).ok();
    let token_program = next_account_info(accounts_iter).ok();

    ValidationHelper::validate_signer(buyer, "Buyer")?;
    
    // CRITICAL FIX: Проверяем, что escrow аккаунт принадлежит программе
    ValidationHelper::validate_program_account(escrow_account, program_id, "escrow_account")?;
    
    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    if escrow_data.get_state()? != EscrowState::SellerConfirmed {
        msg!("Escrow must be in SellerConfirmed state");
        return Err(ProgramError::InvalidAccountData);
    }
    ValidationHelper::validate_participant(&escrow_data, buyer.key, "buyer")?;
    let seller = escrow_data.seller;
    if seller == Pubkey::default() {
        msg!("Seller not set");
        return Err(ProgramError::UninitializedAccount);
    }
    if seller_account.key != &seller {
        msg!("Invalid seller account");
        return Err(ProgramError::InvalidAccountData);
    }
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
    msg!("Escrow confirmed by buyer. Funds released to seller. State: Completed");
    Ok(())
}

/// Instruction 4: Arbiter confirms escrow, funds go to seller (can be called in Funded or SellerConfirmed)
/// Accounts:
///   [signer] arbiter
///   [writable] escrow_account (PDA)
///   [writable] vault (PDA)
///   [writable] seller_account
fn arbiter_confirm(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let arbiter = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let seller = next_account_info(accounts_iter)?;
    let _mint_account = next_account_info(accounts_iter).ok();
    let vault_token_account = next_account_info(accounts_iter).ok();
    let seller_token_account = next_account_info(accounts_iter).ok();
    let token_program = next_account_info(accounts_iter).ok();

    ValidationHelper::validate_signer(arbiter, "Arbiter")?;
    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    let state = escrow_data.get_state()?;
    if state != EscrowState::Funded && state != EscrowState::SellerConfirmed {
        msg!("Escrow must be in Funded or SellerConfirmed state");
        return Err(ProgramError::InvalidAccountData);
    }
    if escrow_data.seller != *seller.key {
        msg!("Invalid seller account");
        return Err(ProgramError::InvalidAccountData);
    }
    ValidationHelper::validate_participant(&escrow_data, arbiter.key, "arbiter")?;
    // CRITICAL FIX: Используем безопасный transfer вместо прямого изменения lamports
    if TokenTransfer::is_native_mint(&escrow_data.mint) {
        TokenTransfer::transfer_sol(vault, seller, escrow_data.amount)?;
    } else {
        let vault_token_account = vault_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
        let seller_token_account = seller_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
        let token_program = token_program.ok_or(ProgramError::NotEnoughAccountKeys)?;
        // CRITICAL FIX: Используем безопасный TokenTransfer вместо unsafe transmute
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
    msg!("Escrow completed by arbiter");
    Ok(())
}

/// Instruction 5: Arbiter cancels escrow, funds return to buyer (can be called in Funded or SellerConfirmed)
/// Accounts:
///   [signer] arbiter
///   [writable] escrow_account (PDA)
///   [writable] vault (PDA)
///   [writable] buyer_account
fn arbiter_cancel(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let arbiter = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let buyer = next_account_info(accounts_iter)?;
    let _mint_account = next_account_info(accounts_iter).ok();
    let vault_token_account = next_account_info(accounts_iter).ok();
    let buyer_token_account = next_account_info(accounts_iter).ok();
    let token_program = next_account_info(accounts_iter).ok();

    ValidationHelper::validate_signer(arbiter, "Arbiter")?;
    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    let state = escrow_data.get_state()?;
    if state != EscrowState::Funded && state != EscrowState::SellerConfirmed {
        msg!("Escrow must be in Funded or SellerConfirmed state");
        return Err(ProgramError::InvalidAccountData);
    }
    if escrow_data.buyer != *buyer.key {
        msg!("Invalid buyer account");
        return Err(ProgramError::InvalidAccountData);
    }
    ValidationHelper::validate_participant(&escrow_data, arbiter.key, "arbiter")?;
    // CRITICAL FIX: Используем безопасный transfer вместо прямого изменения lamports
    if TokenTransfer::is_native_mint(&escrow_data.mint) {
        TokenTransfer::transfer_sol(vault, buyer, escrow_data.amount)?;
    } else {
        let vault_token_account = vault_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
        let buyer_token_account = buyer_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
        let token_program = token_program.ok_or(ProgramError::NotEnoughAccountKeys)?;
        // CRITICAL FIX: Используем безопасный TokenTransfer вместо unsafe transmute
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
    msg!("Escrow cancelled by arbiter");
    Ok(())
}

/// Instruction 8: Buyer and seller mutually cancel escrow, funds return to buyer
/// Accounts:
///   [signer] buyer
///   [signer] seller
///   [writable] escrow_account (PDA)
///   [writable] vault (PDA)
fn mutual_cancel(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let buyer = next_account_info(accounts_iter)?;
    let seller = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;
    let vault = next_account_info(accounts_iter)?;
    let _mint_account = next_account_info(accounts_iter).ok();
    let vault_token_account = next_account_info(accounts_iter).ok();
    let buyer_token_account = next_account_info(accounts_iter).ok();
    let token_program = next_account_info(accounts_iter).ok();

    // CRITICAL FIX: Проверяем подписи в самом начале
    if !buyer.is_signer || !seller.is_signer {
        msg!("Both buyer and seller must sign");
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // CRITICAL FIX: Проверяем, что escrow аккаунт принадлежит программе
    ValidationHelper::validate_program_account(escrow_account, program_id, "escrow_account")?;

    let mut escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    let state = escrow_data.get_state()?;
    if state != EscrowState::Initialized && state != EscrowState::Funded {
        msg!("Escrow can only be cancelled in Initialized or Funded state");
        return Err(ProgramError::InvalidAccountData);
    }
    if escrow_data.buyer != *buyer.key {
        msg!("Invalid buyer account");
        return Err(ProgramError::InvalidAccountData);
    }
    if escrow_data.seller != *seller.key {
        msg!("Invalid seller account");
        return Err(ProgramError::InvalidAccountData);
    }
    // If funded, return funds to buyer
    if state == EscrowState::Funded {
        // CRITICAL FIX: Используем безопасный transfer вместо прямого изменения lamports
        if TokenTransfer::is_native_mint(&escrow_data.mint) {
            TokenTransfer::transfer_sol(vault, buyer, escrow_data.amount)?;
        } else {
            let vault_token_account = vault_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
            let buyer_token_account = buyer_token_account.ok_or(ProgramError::NotEnoughAccountKeys)?;
            let token_program = token_program.ok_or(ProgramError::NotEnoughAccountKeys)?;
            // CRITICAL FIX: Используем безопасный TokenTransfer вместо unsafe transmute
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
    Ok(())
}

/// Instruction 6: Close escrow account, return rent to closer
/// Accounts:
///   [signer] closer (buyer, seller, or arbiter)
///   [writable] escrow_account (PDA)
fn close_escrow(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let closer = next_account_info(accounts_iter)?;
    let escrow_account = next_account_info(accounts_iter)?;

    ValidationHelper::validate_signer(closer, "Closer")?;

    let escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    let state = escrow_data.get_state()?;
    
    if !escrow_data.can_be_closed()? {
        msg!("Escrow must be completed or cancelled");
        return Err(ProgramError::InvalidAccountData);
    }

    if !escrow_data.is_participant(closer.key) {
        msg!("Closer must be participant or arbiter");
        return Err(ProgramError::IllegalOwner);
    }

    let rent = Rent::get()?;
    let rent_exemption = rent.minimum_balance(escrow_account.data_len());
    let account_balance = escrow_account.lamports();
    
    if account_balance > rent_exemption {
        let refund = account_balance - rent_exemption;
        **escrow_account.try_borrow_mut_lamports()? -= refund;
        **closer.try_borrow_mut_lamports()? += refund;
    }

    let mut data = escrow_account.try_borrow_mut_data()?;
    data[0..EscrowAccount::LEN].fill(0);
    
    msg!("Escrow closed");
    Ok(())
}

/// Prints escrow information to the program logs for debugging.
/// 
/// # Accounts
/// * `[]` escrow_account - Escrow PDA to read from
fn get_escrow_info(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let escrow_account = next_account_info(accounts_iter)?;

    let escrow_data = EscrowAccount::from_account_data(&escrow_account.try_borrow_data()?)?;
    
    msg!("Escrow Information:");
    msg!("====================");
    msg!("State: {:?}", escrow_data.get_state()?);
    msg!("Amount: {} lamports", escrow_data.amount);
    msg!("Buyer: {}", escrow_data.buyer);
    msg!("Seller: {}", escrow_data.seller);
    msg!("Arbiter: {}", escrow_data.arbiter);
    msg!("Vault Bump: {}", escrow_data.vault_bump);
    msg!("Mint: {}", escrow_data.mint);
    msg!("====================");
    
    Ok(())
}