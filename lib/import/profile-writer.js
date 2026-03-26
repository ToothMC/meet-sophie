// lib/import/profile-writer.js — Write imported insights to user_profile + user_relationship
import { createClient } from '@supabase/supabase-js';

function getServiceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Write approved Zone C insights to user_profile and user_relationship.
 * @param {string} userId
 * @param {string} sourceId
 * @param {Array<{ type: string, insights: Record<string, any>, content: string }>} approvedItems
 */
export async function writeToProfile(userId, sourceId, approvedItems) {
  const supabase = getServiceClient();

  // Collect profile updates
  const profileUpdates = {};
  const communicationStyle = {};
  const thinkingPattern = {};

  for (const item of approvedItems) {
    const ins = item.insights || {};

    switch (item.type) {
      case 'personal':
        if (ins.name) profileUpdates.first_name = ins.name;
        if (ins.preferred_name) profileUpdates.preferred_name = ins.preferred_name;
        if (ins.occupation) profileUpdates.occupation = ins.occupation;
        if (ins.language) profileUpdates.preferred_language = ins.language;
        if (ins.age) profileUpdates.age = ins.age;
        break;

      case 'communication':
        if (ins.style) communicationStyle.style = ins.style;
        if (ins.tone) communicationStyle.tone = ins.tone;
        if (ins.language) communicationStyle.language = ins.language;
        if (ins.preferences) communicationStyle.preferences = ins.preferences;
        break;

      case 'preference':
        if (ins.likes) {
          const existing = profileUpdates.topics_like || [];
          profileUpdates.topics_like = [...new Set([...existing, ...(Array.isArray(ins.likes) ? ins.likes : [ins.likes])])];
        }
        if (ins.dislikes) {
          const existing = profileUpdates.topics_avoid || [];
          profileUpdates.topics_avoid = [...new Set([...existing, ...(Array.isArray(ins.dislikes) ? ins.dislikes : [ins.dislikes])])];
        }
        break;

      case 'pattern':
        if (ins.approach) thinkingPattern.approach = ins.approach;
        if (ins.patterns) thinkingPattern.patterns = ins.patterns;
        break;
    }
  }

  // Update user_profile
  if (Object.keys(profileUpdates).length > 0) {
    profileUpdates.imported_from = sourceId;
    profileUpdates.import_date = new Date().toISOString();
    profileUpdates.import_verified = false;
    profileUpdates.source_id = sourceId;

    await supabase.from('user_profile')
      .update(profileUpdates)
      .eq('user_id', userId);
  }

  // Update user_relationship
  if (Object.keys(communicationStyle).length > 0 || Object.keys(thinkingPattern).length > 0) {
    const relUpdates = { source_id: sourceId };
    if (Object.keys(communicationStyle).length > 0) relUpdates.communication_style = communicationStyle;
    if (Object.keys(thinkingPattern).length > 0) relUpdates.thinking_pattern = thinkingPattern;

    await supabase.from('user_relationship')
      .update(relUpdates)
      .eq('user_id', userId);
  }
}
