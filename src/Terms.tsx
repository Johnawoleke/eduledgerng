import { DashboardLayout } from "@/components/dashboard/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

const Terms = () => {
  return (
    <DashboardLayout>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Academic Terms</h1>
        <Button className="flex items-center gap-2">
          <Plus className="h-4 w-4" /> Add Term
        </Button>
      </div>
      <div className="bg-white p-6 rounded-lg shadow">
        <p className="text-muted-foreground text-center py-10">
          Select a session above to manage academic terms.
        </p>
      </div>
    </DashboardLayout>
  );
};

export default Terms;
