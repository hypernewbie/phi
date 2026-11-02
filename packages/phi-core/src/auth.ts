export interface AuthStatus {
    enabled: boolean;
    authenticated: boolean;
    owned: boolean;
}

export interface CredentialBundle {
    token: string;
    expiresAt: number;
    expiresIn: number;
    refreshIdleExpiresAt: number;
    refreshAbsoluteExpiresAt: number;
}
