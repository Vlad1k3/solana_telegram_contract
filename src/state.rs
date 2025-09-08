use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
};

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EscrowState {
    Uninitialized = 0,
    Created = 1,
    Initialized = 2,
    Funded = 3,
    SellerConfirmed = 4,
    BuyerConfirmed = 5,
    Completed = 6,
    Cancelled = 7,
}

impl EscrowState {
    pub fn from_u8(value: u8) -> Result<Self, ProgramError> {
        match value {
            0 => Ok(EscrowState::Uninitialized),
            1 => Ok(EscrowState::Created),
            2 => Ok(EscrowState::Initialized),
            3 => Ok(EscrowState::Funded),
            4 => Ok(EscrowState::SellerConfirmed),
            5 => Ok(EscrowState::BuyerConfirmed),
            6 => Ok(EscrowState::Completed),
            7 => Ok(EscrowState::Cancelled),
            _ => {
                msg!("Invalid escrow state: {}", value);
                Err(ProgramError::InvalidAccountData)
            }
        }
    }
}

#[repr(C)]
#[derive(Debug)]
pub struct EscrowAccount {
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub arbiter: Pubkey,
    pub amount: u64,
    pub state: u8,
    pub vault_bump: u8,
    pub mint: Pubkey,
    pub fee_collector: Pubkey,
}

impl EscrowAccount {
    pub const LEN: usize = 32 + 32 + 32 + 8 + 1 + 1 + 32 + 32; // +32 для fee_collector

    pub fn new(
        buyer: &Pubkey,
        arbiter: &Pubkey,
        amount: u64,
        vault_bump: u8,
        mint: &Pubkey,
        fee_collector: &Pubkey,
    ) -> Self {
        Self {
            buyer: *buyer,
            seller: Pubkey::default(),
            arbiter: *arbiter,
            amount,
            state: EscrowState::Created as u8,
            vault_bump,
            mint: *mint,
            fee_collector: *fee_collector,
        }
    }
    
    pub fn from_account_data(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != Self::LEN {
            msg!("Invalid account size: expected {}, got {}", Self::LEN, data.len());
            return Err(ProgramError::InvalidAccountData);
        }
        
        let buyer = Pubkey::new_from_array(data[0..32].try_into().unwrap());
        let seller = Pubkey::new_from_array(data[32..64].try_into().unwrap());
        let arbiter = Pubkey::new_from_array(data[64..96].try_into().unwrap());
        let amount = u64::from_le_bytes(data[96..104].try_into().unwrap());
        let state = data[104];
        let vault_bump = data[105];
        let mint = Pubkey::new_from_array(data[106..138].try_into().unwrap());
        let fee_collector = Pubkey::new_from_array(data[138..170].try_into().unwrap());
        
        Ok(Self {
            buyer,
            seller,
            arbiter,
            amount,
            state,
            vault_bump,
            mint,
            fee_collector,
        })
    }
    
    pub fn save_to_account(&self, account: &AccountInfo) -> ProgramResult {
        let mut data = account.try_borrow_mut_data()?;
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        
        data[0..32].copy_from_slice(self.buyer.as_ref());
        data[32..64].copy_from_slice(self.seller.as_ref());
        data[64..96].copy_from_slice(self.arbiter.as_ref());
        data[96..104].copy_from_slice(&self.amount.to_le_bytes());
        data[104] = self.state;
        data[105] = self.vault_bump;
        data[106..138].copy_from_slice(self.mint.as_ref());
        data[138..170].copy_from_slice(self.fee_collector.as_ref());
        
        Ok(())
    }
    
    pub fn get_state(&self) -> Result<EscrowState, ProgramError> {
        EscrowState::from_u8(self.state)
    }
    
    pub fn set_state(&mut self, state: EscrowState) {
        self.state = state as u8;
    }

    pub fn is_participant(&self, pubkey: &Pubkey) -> bool {
        *pubkey == self.buyer || *pubkey == self.seller || *pubkey == self.arbiter
    }

    pub fn can_be_closed(&self) -> Result<bool, ProgramError> {
        let state = self.get_state()?;
        Ok(state == EscrowState::Completed || state == EscrowState::Cancelled)
    }
}