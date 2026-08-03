import React, { createContext, useContext, useState, ReactNode, useCallback } from "react";

interface StudentData {
  id: string;
  student_id: string;
  name: string;
  class: string;
  term?: string | null;
  session?: string | null;
  school_id?: string;
  must_change_pin?: boolean;
}

interface SchoolData {
  id: string;
  name: string;
}

interface FeeItem {
  id: string;
  name: string;
  amount: number;
  paid: number;
  status: string;
  session_id?: string | null;
  term_id?: string | null;
}

interface PaymentRecord {
  id: string;
  amount: number;
  date: string;
  reference: string;
  method: string;
  items: string[];
  session_id?: string | null;
  term_id?: string | null;
}

// The student session is an opaque bearer token issued by student-auth, with a
// server-side expiry. It replaces the old scheme, which kept the student's
// PASSWORD in localStorage forever and re-sent it on every privileged call —
// any XSS or shared school computer meant permanent account compromise, and
// there was nothing to revoke. A token can be revoked (and is, on every
// password change) and dies on its own.
export interface StudentSession {
  token: string;
  expiresAt: string | null;
}

interface SchoolContextType {
  school: SchoolData | null;
  student: StudentData | null;
  feeItems: FeeItem[];
  payments: PaymentRecord[];
  schoolSlug: string;
  isStudentLoggedIn: boolean;
  studentSession: StudentSession | null;
  setSchool: (school: SchoolData | null) => void;
  loginStudent: (student: StudentData, fees: FeeItem[], payments: PaymentRecord[], session: StudentSession) => void;
  setStudentData: (fees: FeeItem[], payments: PaymentRecord[]) => void;
  updateStudentSession: (session: StudentSession) => void;
  logoutStudent: () => void;
}

const SchoolContext = createContext<SchoolContextType>({} as SchoolContextType);

// A corrupt value (e.g. the string "undefined") must never crash the provider —
// that renders as a white screen before the ErrorBoundary can help.
const readStored = <T,>(key: string, fallback: T): T => {
  try {
    const saved = localStorage.getItem(key);
    return saved ? (JSON.parse(saved) as T) : fallback;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
};

const writeStored = (key: string, value: unknown) => {
  try {
    if (value === undefined || value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    /* storage full or unavailable — keep in-memory state working */
  }
};

export const SchoolProvider = ({ children }: { children: ReactNode }) => {
  // Initialize state from localStorage if available, so data survives refreshes
  const [school, setSchoolState] = useState<SchoolData | null>(() => readStored("pity_school", null));
  const [student, setStudent] = useState<StudentData | null>(() => readStored("pity_student", null));
  const [feeItems, setFeeItems] = useState<FeeItem[]>(() => readStored("pity_fees", []));
  const [payments, setPayments] = useState<PaymentRecord[]>(() => readStored("pity_payments", []));
  const [schoolSlug] = useState(() => localStorage.getItem("pity_slug") || "");
  const [studentSession, setStudentSession] = useState<StudentSession | null>(() => {
    // Any credential stored by an older build is a plaintext password. Drop it
    // on sight rather than leaving it sitting in localStorage.
    localStorage.removeItem("pity_credentials");

    const stored = readStored<StudentSession | null>("pity_session", null);
    if (!stored?.token) return null;
    if (stored.expiresAt && new Date(stored.expiresAt).getTime() <= Date.now()) {
      localStorage.removeItem("pity_session");
      return null;
    }
    return stored;
  });

  // Custom setter for school to update localStorage simultaneously
  const setSchool = useCallback((schoolData: SchoolData | null) => {
    setSchoolState(schoolData);
    writeStored("pity_school", schoolData);
  }, []);

  const loginStudent = useCallback((
    studentData: StudentData,
    fees: FeeItem[],
    paymentList: PaymentRecord[],
    session: StudentSession
  ) => {
    setStudent(studentData);
    setFeeItems(fees);
    setPayments(paymentList);
    setStudentSession(session);

    writeStored("pity_student", studentData);
    writeStored("pity_fees", fees);
    writeStored("pity_payments", paymentList);
    writeStored("pity_session", session);
  }, []);

  const setStudentData = useCallback((fees: FeeItem[], paymentList: PaymentRecord[]) => {
    setFeeItems(fees);
    setPayments(paymentList);
    writeStored("pity_fees", fees);
    writeStored("pity_payments", paymentList);
  }, []);

  // A password change revokes every prior session server-side and issues a new
  // one; swap it in so the current tab stays logged in.
  const updateStudentSession = useCallback((session: StudentSession) => {
    setStudentSession(session);
    writeStored("pity_session", session);
  }, []);

  const logoutStudent = useCallback(() => {
    setSchoolState(null);
    setStudent(null);
    setFeeItems([]);
    setPayments([]);
    setStudentSession(null);

    localStorage.removeItem("pity_school");
    localStorage.removeItem("pity_student");
    localStorage.removeItem("pity_fees");
    localStorage.removeItem("pity_payments");
    localStorage.removeItem("pity_session");
    localStorage.removeItem("pity_credentials");
    localStorage.removeItem("pity_slug");
  }, []);

  return (
    <SchoolContext.Provider
      value={{
        school,
        student,
        feeItems,
        payments,
        schoolSlug,
        isStudentLoggedIn: !!student && !!studentSession,
        studentSession,
        setSchool,
        loginStudent,
        setStudentData,
        updateStudentSession,
        logoutStudent,
      }}
    >
      {children}
    </SchoolContext.Provider>
  );
};

export const useSchool = () => useContext(SchoolContext);
