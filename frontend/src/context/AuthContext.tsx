import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, getStoredToken, setStoredToken } from '../api/client';
import type { AuthModeResponse, RegisterResponse, UserSummary } from '../types/api';

interface AuthContextValue {
  user: UserSummary | null;
  authMode: AuthModeResponse | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<UserSummary>;
  register: (
    da: string,
    name: string,
    password: string,
    teacherId?: number | null
  ) => Promise<RegisterResponse>;
  logout: () => void;
  refreshUser: () => Promise<UserSummary | null>;
  setUser: (user: UserSummary | null) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserSummary | null>(null);
  const [authMode, setAuthMode] = useState<AuthModeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async (): Promise<UserSummary | null> => {
    if (!getStoredToken()) {
      setUser(null);
      return null;
    }
    try {
      const me = await api.getMe();
      setUser(me);
      return me;
    } catch {
      setStoredToken(null);
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const mode = await api.getAuthMode().catch(() => null);
        if (active && mode) setAuthMode(mode);
        if (getStoredToken()) {
          const me = await api.getMe().catch(() => null);
          if (active) {
            setUser(me);
            if (!me) setStoredToken(null);
          }
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const login = async (identifier: string, password: string) => {
    const res = await api.login(identifier.trim(), password);
    setStoredToken(res.access_token);
    setUser(res.user);
    return res.user;
  };

  const register = async (
    da: string,
    name: string,
    password: string,
    teacherId?: number | null
  ): Promise<RegisterResponse> => {
    const res = await api.register(da.trim(), name.trim(), password, teacherId ?? null);
    if (!res.pending_approval && res.access_token && res.user) {
      setStoredToken(res.access_token);
      setUser(res.user);
    }
    return res;
  };

  const logout = () => {
    setStoredToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{ user, authMode, loading, login, register, logout, refreshUser, setUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
