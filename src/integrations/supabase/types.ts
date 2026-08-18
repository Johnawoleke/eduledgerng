// Hand-reconciled against the LIVE Supabase project (ifonivphhfplntzshtsb) on 2026-07-06.
// The live database is the source of truth — it uses `sessions`/`terms` (NOT the
// `academic_sessions`/`academic_terms` names found in older migrations). If you change
// the schema, update this file and supabase/migrations/ together.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      class_fees: {
        Row: {
          amount: number
          approved_at: string | null
          approved_by: string | null
          class_target: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          school_id: string
          session_id: string | null
          status: string
          term_id: string | null
        }
        Insert: {
          amount: number
          approved_at?: string | null
          approved_by?: string | null
          class_target: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          school_id: string
          session_id?: string | null
          status?: string
          term_id?: string | null
        }
        Update: {
          amount?: number
          approved_at?: string | null
          approved_by?: string | null
          class_target?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          school_id?: string
          session_id?: string | null
          status?: string
          term_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "class_fees_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      fee_items: {
        Row: {
          amount: number
          created_at: string
          id: string
          name: string
          paid: number
          school_id: string
          status: string
          student_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          name: string
          paid?: number
          school_id: string
          status?: string
          student_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          name?: string
          paid?: number
          school_id?: string
          status?: string
          student_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          amount: number | null
          body: string | null
          created_at: string
          id: string
          metadata: Json
          read_at: string | null
          reference: string | null
          school_id: string
          title: string
          type: string
        }
        Insert: {
          amount?: number | null
          body?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          read_at?: string | null
          reference?: string | null
          school_id: string
          title: string
          type?: string
        }
        Update: {
          amount?: number | null
          body?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          read_at?: string | null
          reference?: string | null
          school_id?: string
          title?: string
          type?: string
        }
        Relationships: []
      }
      payment_events: {
        Row: {
          amount_usd: number | null
          created_at: string
          event_type: string | null
          id: string
          payload: Json | null
          payment_id: string | null
          status: string | null
        }
        Insert: {
          amount_usd?: number | null
          created_at?: string
          event_type?: string | null
          id?: string
          payload?: Json | null
          payment_id?: string | null
          status?: string | null
        }
        Update: {
          amount_usd?: number | null
          created_at?: string
          event_type?: string | null
          id?: string
          payload?: Json | null
          payment_id?: string | null
          status?: string | null
        }
        Relationships: []
      }
      payments: {
        Row: {
          amount: number | null
          amount_paid: number | null
          created_at: string
          date: string
          // Which provider processed this row (20260806100000). Always
          // "paystack" now; the column stays so a second gateway can be routed
          // in without a migration.
          gateway: string | null
          id: string
          items: string[] | null
          method: string | null
          reference: string | null
          school_id: string
          session_id: string | null
          status: string
          student_id: string
          term_id: string | null
        }
        Insert: {
          amount?: number | null
          amount_paid?: number | null
          created_at?: string
          date?: string
          gateway?: string | null
          id?: string
          items?: string[] | null
          method?: string | null
          reference?: string | null
          school_id: string
          session_id?: string | null
          status?: string
          student_id: string
          term_id?: string | null
        }
        Update: {
          amount?: number | null
          amount_paid?: number | null
          created_at?: string
          date?: string
          gateway?: string | null
          id?: string
          items?: string[] | null
          method?: string | null
          reference?: string | null
          school_id?: string
          session_id?: string | null
          status?: string
          student_id?: string
          term_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          must_change_password: boolean
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          must_change_password?: boolean
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          must_change_password?: boolean
        }
        Relationships: []
      }
      school_admins: {
        Row: {
          created_at: string
          id: string
          role: string
          school_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: string
          school_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: string
          school_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "school_admins_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      school_requests: {
        Row: {
          created_at: string
          email: string | null
          expires_at: string
          id: string
          requested_by: string
          role: string
          school_id: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          expires_at: string
          id?: string
          requested_by: string
          role?: string
          school_id: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          expires_at?: string
          id?: string
          requested_by?: string
          role?: string
          school_id?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "school_requests_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      schools: {
        Row: {
          account_name: string | null
          account_number: string | null
          address: string | null
          bank_name: string | null
          created_at: string
          email: string | null
          id: string
          logo_url: string | null
          name: string
          owner_id: string
          phone: string | null
          school_code: string | null
          settings: Json | null
          slug: string
          status: string | null
          updated_at: string
        }
        Insert: {
          account_name?: string | null
          account_number?: string | null
          address?: string | null
          bank_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          logo_url?: string | null
          name: string
          owner_id: string
          phone?: string | null
          school_code?: string | null
          settings?: Json | null
          slug: string
          status?: string | null
          updated_at?: string
        }
        Update: {
          account_name?: string | null
          account_number?: string | null
          address?: string | null
          bank_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          logo_url?: string | null
          name?: string
          owner_id?: string
          phone?: string | null
          school_code?: string | null
          settings?: Json | null
          slug?: string
          status?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      sessions: {
        Row: {
          created_at: string
          end_year: number | null
          id: string
          is_current: boolean | null
          name: string
          school_id: string
          start_year: number | null
        }
        Insert: {
          created_at?: string
          end_year?: number | null
          id?: string
          is_current?: boolean | null
          name: string
          school_id: string
          start_year?: number | null
        }
        Update: {
          created_at?: string
          end_year?: number | null
          id?: string
          is_current?: boolean | null
          name?: string
          school_id?: string
          start_year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sessions_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      // The fee ledger (20260818120000). Both are member-readable but have NO
      // client insert/update/delete policy — rows are written only by the
      // charge-generation triggers or a service-role function, exactly like
      // payments. Insert/Update are typed as never to make that explicit.
      student_charges: {
        Row: {
          id: string
          school_id: string
          student_id: string
          class_fee_id: string
          session_id: string | null
          term_id: string | null
          // The class the student was in when this charge was raised, kept so a
          // charge still explains itself after they are promoted away from it.
          class_at_charge: string
          amount: number
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      student_enrolments: {
        Row: {
          id: string
          school_id: string
          student_id: string
          session_id: string
          class: string
          status: string
          created_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      // student_sessions and student_auth_throttle (20260803120000) are
      // deliberately absent: RLS is enabled on both with NO policy, so they are
      // unreachable with the anon key and only the service-role edge functions
      // touch them. Adding Row types here would imply a client can read them.
      students: {
        Row: {
          class: string
          // The one-time temporary password the school issued, in plaintext, so
          // an owner can read it back to hand over. Cleared to null the moment
          // the student sets their own (student-set-pin / change-pin).
          default_pin: string | null
          first_name: string | null
          full_name: string | null
          id: string
          is_first_login: boolean | null
          must_change_pin: boolean | null
          name: string
          // Optional. When absent, create-payment synthesises a bouncing
          // address on a domain we own — see that function for why.
          parent_email: string | null
          // bcrypt digest. The hash_student_pin trigger (20260803110000) hashes
          // whatever is written here, so callers still assign a plaintext value
          // and the database stores the digest. Only verify_student_pin can
          // check it.
          pin: string
          school_id: string
          session: string | null
          session_id: string | null
          status: string | null
          student_id: string
          surname: string | null
          term: string | null
          term_id: string | null
        }
        Insert: {
          class: string
          default_pin?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string
          is_first_login?: boolean | null
          must_change_pin?: boolean | null
          name: string
          parent_email?: string | null
          pin: string
          school_id: string
          session?: string | null
          session_id?: string | null
          status?: string | null
          student_id: string
          surname?: string | null
          term?: string | null
          term_id?: string | null
        }
        Update: {
          class?: string
          default_pin?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string
          is_first_login?: boolean | null
          must_change_pin?: boolean | null
          name?: string
          parent_email?: string | null
          pin?: string
          school_id?: string
          session?: string | null
          session_id?: string | null
          status?: string | null
          student_id?: string
          surname?: string | null
          term?: string | null
          term_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "students_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      terms: {
        Row: {
          id: string
          is_current: boolean | null
          name: string
          school_id: string
          session_id: string
          term_number: number | null
        }
        Insert: {
          id?: string
          is_current?: boolean | null
          name: string
          school_id: string
          session_id: string
          term_number?: number | null
        }
        Update: {
          id?: string
          is_current?: boolean | null
          name?: string
          school_id?: string
          session_id?: string
          term_number?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "terms_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      is_bcrypt_hash: { Args: { p_value: string }; Returns: boolean }
      is_school_member: { Args: { school_id_param: string }; Returns: boolean }
      is_school_owner: { Args: { school_id_param: string }; Returns: boolean }
      // Student session lifecycle (20260803120000). Called only by the
      // service-role edge functions — student_sessions has no RLS policy.
      create_student_session: {
        Args: {
          p_school_id: string
          p_student_id: string
          p_token: string
          p_ttl_hours?: number
        }
        Returns: string
      }
      revoke_student_sessions: { Args: { p_student_id: string }; Returns: undefined }
      verify_student_session: {
        Args: { p_token: string }
        Returns: {
          class: string
          id: string
          must_change_pin: boolean
          name: string
          school_id: string
          session: string
          student_id: string
          term: string
        }[]
      }
      // Per-IP login throttle (20260803120000).
      student_auth_throttle_check: { Args: { p_ip: string }; Returns: boolean }
      student_auth_throttle_reset: { Args: { p_ip: string }; Returns: undefined }
      verify_student_pin: {
        Args: { p_pin: string; p_school_id: string; p_student_id: string }
        Returns: {
          class: string
          id: string
          must_change_pin: boolean
          name: string
          school_id: string
          session: string
          student_id: string
          term: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
