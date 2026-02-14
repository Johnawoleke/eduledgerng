import React, { createContext, useContext, useState, ReactNode } from "react";
import { Student } from "./mockData";

interface AuthContextType {
  user: Student | null;
  isAdmin: boolean;
  login: (user: Student) => void;
  loginAdmin: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<Student | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const login = (student: Student) => {
    setUser(student);
    setIsAdmin(false);
  };

  const loginAdmin = () => {
    setUser(null);
    setIsAdmin(true);
  };

  const logout = () => {
    setUser(null);
    setIsAdmin(false);
  };

  return (
    <AuthContext.Provider value={{ user, isAdmin, login, loginAdmin, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
