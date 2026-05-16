import React, { createContext, useContext, useState, ReactNode, useEffect } from "react";

interface StudentData {
  id: string;
  student_id: string;
  name: string;
  class: string;
  term: string;
  session: string;
  school_id: string;
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

export const SchoolProvider = ({ children }: { children: ReactNode }) => {
  // Initialize state from localStorage if available, so data survives refreshes
  const [school, setSchoolState] = useState<SchoolData | null>(() => {
    const saved = localStorage.getItem("pity_school");
    return saved ? JSON.parse(saved) : null;
  });

  const [student, setStudent] = useState<StudentData | null>(() => {
    const saved = localStorage.getItem("pity_student");
    return saved ? JSON.parse(saved) : null;
  });

  const [feeItems, setFeeItems] = useState<FeeItem[]>(() => {
    const saved = localStorage.getItem("pity_fees");
    return saved ? JSON.parse(saved) : [];
  });

  const [payments, setPayments] = useState<PaymentRecord[]>(() => {
    const saved = localStorage.getItem("pity_payments");
    return saved ? JSON.parse(saved) : [];
  });

  const [schoolSlug, setSchoolSlug] = useState(() => {
    return localStorage.getItem("pity_slug") || "";
  });

  const [studentCredentials, setStudentCredentials] = useState<{ student_id: string; pin: string } | null>(() => {
    const saved = localStorage.getItem("pity_credentials");
    return saved ? JSON.parse(saved) : null;
  });

  // Custom setter for school to update localStorage simultaneously
  const setSchool = (schoolData: SchoolData | null) => {
    setSchoolState(schoolData);
    if (schoolData) {
      localStorage.setItem("pity_school", JSON.stringify(schoolData));
    } else {
      localStorage.removeItem("pity_school");
    }
  };

  const loginStudent = (
    studentData: StudentData,
    fees: FeeItem[],
    paymentList: PaymentRecord[],
    credentials: { student_id: string; pin: string }
  ) => {
    setStudent(studentData);
    setFeeItems(fees);
    setPayments(paymentList);
    setStudentCredentials(credentials);

    localStorage.setItem("pity_student", JSON.stringify(studentData));
    localStorage.setItem("pity_fees", JSON.stringify(fees));
    localStorage.setItem("pity_payments", JSON.stringify(paymentList));
    localStorage.setItem("pity_credentials", JSON.stringify(credentials));
  };

  const setStudentData = (fees: FeeItem[], paymentList: PaymentRecord[]) => {
    setFeeItems(fees);
    setPayments(paymentList);
    localStorage.setItem("pity_fees", JSON.stringify(fees));
    localStorage.setItem("pity_payments", JSON.stringify(paymentList));
  };

  const logoutStudent = () => {
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
  };

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
