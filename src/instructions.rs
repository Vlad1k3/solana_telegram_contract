use solana_program::{
    program_error::ProgramError,
};

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EscrowInstruction {
    CreateOffer = 0,
    JoinOffer = 1,
    FundEscrow = 2,
    ConfirmEscrow = 3,
    ArbiterConfirm = 4,
    ArbiterCancel = 5,
    CloseEscrow = 6,
    GetEscrowInfo = 7,
    MutualCancel = 8,
    SellerConfirm = 9,
}

impl EscrowInstruction {
    pub fn from_u8(value: u8) -> Result<Self, ProgramError> {
        match value {
            0 => Ok(EscrowInstruction::CreateOffer),
            1 => Ok(EscrowInstruction::JoinOffer),
            2 => Ok(EscrowInstruction::FundEscrow),
            3 => Ok(EscrowInstruction::ConfirmEscrow),
            4 => Ok(EscrowInstruction::ArbiterConfirm),
            5 => Ok(EscrowInstruction::ArbiterCancel),
            6 => Ok(EscrowInstruction::CloseEscrow),
            7 => Ok(EscrowInstruction::GetEscrowInfo),
            8 => Ok(EscrowInstruction::MutualCancel),
            9 => Ok(EscrowInstruction::SellerConfirm),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

#[derive(Debug)]
pub enum EscrowError {
    InvalidRole,
    InvalidState,
    InvalidParty,
    AccountAlreadySet,
    InsufficientFunds,
    InvalidVault,
    InvalidMint,
}

impl From<EscrowError> for ProgramError {
    fn from(e: EscrowError) -> Self {
        match e {
            EscrowError::InvalidRole => ProgramError::Custom(100),
            EscrowError::InvalidState => ProgramError::Custom(101),
            EscrowError::InvalidParty => ProgramError::Custom(102),
            EscrowError::AccountAlreadySet => ProgramError::Custom(103),
            EscrowError::InsufficientFunds => ProgramError::Custom(104),
            EscrowError::InvalidVault => ProgramError::Custom(105),
            EscrowError::InvalidMint => ProgramError::Custom(106),
        }
    }
}