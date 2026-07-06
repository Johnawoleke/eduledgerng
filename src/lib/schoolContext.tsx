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

interface SchoolContextType {
  school: SchoolData | null;
  student: StudentData | null;
  feeItems: FeeItem[];
  payments: PaymentRecord[];
  schoolSlug: string;
  isStudentLoggedIn: boolean;
  studentCredentials: { student_id: string; pin: string } | null;
  setSchool: (school: SchoolData | null) => void;
  loginStudent: (student: StudentData, fees: FeeItem[], payments: PaymentRecord[], credentials: { student_id: string; pin: string }) => void;
  setStudentData: (fees: FeeItem[], payments: PaymentRecord[]) => void;
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
  const [studentCredentials, setStudentCredentials] = useState<{ student_id: string; pin: string } | null>(
    () => readStored("pity_credentials", null)
  );

  // Custom setter for school to update localStorage simultaneously
  const setSchool = useCallback((schoolData: SchoolData | null) => {
    setSchoolState(schoolData);
    writeStored("pity_school", schoolData);
  }, []);

  const loginStudent = useCallback((
    studentData: StudentData,
    fees: FeeItem[],
    paymentList: PaymentRecord[],
    credentials: { student_id: string; pin: string }
  ) => {
    setStudent(studentData);
    setFeeItems(fees);
    setPayments(paymentList);
    setStudentCredentials(credentials);

    writeStored("pity_student", studentData);
    writeStored("pity_fees", fees);
    writeStored("pity_payments", paymentList);
    writeStored("pity_credentials", credentials);
  }, []);

  const setStudentData = useCallback((fees: FeeItem[], paymentList: PaymentRecord[]) => {
    setFeeItems(fees);
    setPayments(paymentList);
    writeStored("pity_fees", fees);
    writeStored("pity_payments", paymentList);
  }, []);

  const logoutStudent = useCallback(() => {
    setSchoolState(null);
    setStudent(null);
    setFeeItems([]);
    setPayments([]);
    setStudentCredentials(null);

    localStorage.removeItem("pity_school");
    localStorage.removeItem("pity_student");
    localStorage.removeItem("pity_fees");
    localStorage.removeItem("pity_payments");
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
        isStudentLoggedIn: !!student,
        studentCredentials,
        setSchool,
        loginStudent,
        setStudentData,
        logoutStudent,
      }}
    >
      {children}
    </SchoolContext.Provider>
  );
};

export const useSchool = () => useContext(SchoolContext);
