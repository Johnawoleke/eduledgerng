import React, { createContext, useContext, useState, ReactNode } from "react";

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
  const [school, setSchool] = useState<SchoolData | null>(null);
  const [student, setStudent] = useState<StudentData | null>(null);
  const [feeItems, setFeeItems] = useState<FeeItem[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [schoolSlug, setSchoolSlug] = useState("");
  const [studentCredentials, setStudentCredentials] = useState<{ student_id: string; pin: string } | null>(null);

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
  };

  const setStudentData = (fees: FeeItem[], paymentList: PaymentRecord[]) => {
    setFeeItems(fees);
    setPayments(paymentList);
  };

  const logoutStudent = () => {
    setStudent(null);
    setFeeItems([]);
    setPayments([]);
    setStudentCredentials(null);
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
