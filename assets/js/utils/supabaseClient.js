import { createClient } from 'https://esm.sh/@supabase/supabase-js'

const supabaseUrl = 'https://wnxzeklcoxjyfkagbfvm.supabase.co'

const supabaseKey =
  'sb_publishable_sBBZErFYXJ7h1t6v-H4aYQ_UUPMvusG'

export const supabase = createClient(
  supabaseUrl,
  supabaseKey
)
