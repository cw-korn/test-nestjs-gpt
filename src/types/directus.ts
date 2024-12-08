export interface ExamAiSchoolDetails {
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
  programs?: string[];
  display_order?: number;
  school?: ExamAiSchools;
}

export interface ExamAiSchools {
  id: number;
  school_id: string;
  name: string;
  details: string;
  district: string;
  province: string;
  school_details: ExamAiSchoolDetails[];
  students?: any;
}

export interface ExamAiSchoolApplicantSummaries {
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
  school?: ExamAiSchools;
}

export interface DirectusSchema {
  exam_ai_schools: ExamAiSchools;
  exam_ai_school_details: ExamAiSchoolDetails;
  exam_ai_school_applicant_summaries: ExamAiSchoolApplicantSummaries;
}