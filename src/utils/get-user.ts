import supabase from "../supabase";

export async function getUserEmail(userId: string) {
    const { data, error } = await supabase.auth.admin.getUserById(userId);

    if (error) {
        console.error("Error fetching user:", error);
        return null;
    }

    return data.user;
}