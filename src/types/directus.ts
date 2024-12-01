// src/types/directus.ts
export interface DirectusSchema {
    exam_ai_schools: {
      id: number;
      school_id: string;
      name: string;
      details: string;
      district: string;
      province: string;
      school_details?: any; 
      students?: any; 
    };
  
    exam_ai_school_details: {
      id: number;
      school_id: string;
      type: string;
      exam_date: string;
      result_date: string;
      report_date: string;
      open_application_date: string;
      close_application_date: string;
      orientation_date: string;
      exam_location: string;
      programs?: any;
      display_order?: number;
      created_by?: string;
      created_time?: string;
      updated_by?: string;
      updated_time?: string;
    };
  
    exam_ai_school_applicant_summaries: {
      id: number;
      school_id: string;
      type: string;
      program: string;
      year: number;
      in_district_quota: number;
      out_district_quota?: number;
      special_district_quota?: number;
      in_district_applicants: number;
      out_district_applicants?: number;
      special_applicants?: number;
      in_district_pass_rate: number;
      out_district_pass_rate?: number;
      special_condition_pass_rate?: number;
      created_by?: string;
      created_time?: string;
      updated_by?: string;
      updated_time?: string;
    };
  }