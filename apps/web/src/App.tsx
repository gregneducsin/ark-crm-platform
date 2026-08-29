import { Route, Switch } from "wouter";
import { LoginPage } from "./pages/LoginPage";
import { AcceptInvitationPage } from "./pages/AcceptInvitationPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LeadsPage } from "./pages/LeadsPage";
import { OrdersPage } from "./pages/OrdersPage";
import { FailedPaymentsPage } from "./pages/FailedPaymentsPage";
import { CustomerDetailPage } from "./pages/CustomerDetailPage";
import { PayrollEmployeesPage } from "./pages/PayrollEmployeesPage";
import { PayrollWeeksPage } from "./pages/PayrollWeeksPage";
import { PayrollWeekDetailPage } from "./pages/PayrollWeekDetailPage";
import { MarketingCpaPage } from "./pages/MarketingCpaPage";
import { QuestionnairesPage } from "./pages/QuestionnairesPage";
import { ConversationsPage } from "./pages/ConversationsPage";
import { SupportPage } from "./pages/SupportPage";
import { NeedsAttentionPage } from "./pages/NeedsAttentionPage";
import { UnmatchedContactsPage } from "./pages/UnmatchedContactsPage";
import { ReportingPage } from "./pages/ReportingPage";
import { UsersPage } from "./pages/UsersPage";
import { ProtectedRoute } from "./components/ProtectedRoute";

export default function App() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/accept-invitation" component={AcceptInvitationPage} />

      <Route path="/">
        <ProtectedRoute roles={["admin"]}>
          <DashboardPage />
        </ProtectedRoute>
      </Route>

      <Route path="/customers">
        <ProtectedRoute roles={["admin", "manager"]}>
          <LeadsPage />
        </ProtectedRoute>
      </Route>

      <Route path="/customers/:id">
        <ProtectedRoute roles={["admin", "manager", "customer_service"]}>
          <CustomerDetailPage />
        </ProtectedRoute>
      </Route>

      <Route path="/orders">
        <ProtectedRoute roles={["admin", "manager"]}>
          <OrdersPage />
        </ProtectedRoute>
      </Route>

      <Route path="/failed-payments">
        <ProtectedRoute roles={["admin", "manager"]}>
          <FailedPaymentsPage />
        </ProtectedRoute>
      </Route>

      <Route path="/payroll/employees">
        <ProtectedRoute roles={["admin", "manager"]}>
          <PayrollEmployeesPage />
        </ProtectedRoute>
      </Route>

      <Route path="/payroll/weeks">
        <ProtectedRoute roles={["admin", "manager"]}>
          <PayrollWeeksPage />
        </ProtectedRoute>
      </Route>

      <Route path="/payroll/weeks/:id">
        <ProtectedRoute roles={["admin", "manager"]}>
          <PayrollWeekDetailPage />
        </ProtectedRoute>
      </Route>

      <Route path="/marketing-cpa">
        <ProtectedRoute roles={["admin"]}>
          <MarketingCpaPage />
        </ProtectedRoute>
      </Route>

      <Route path="/questionnaires">
        <ProtectedRoute roles={["admin"]}>
          <QuestionnairesPage />
        </ProtectedRoute>
      </Route>

      <Route path="/conversations">
        <ProtectedRoute roles={["admin", "customer_service"]}>
          <ConversationsPage />
        </ProtectedRoute>
      </Route>

      <Route path="/support">
        <ProtectedRoute roles={["admin", "customer_service"]}>
          <SupportPage />
        </ProtectedRoute>
      </Route>

      <Route path="/needs-attention">
        <ProtectedRoute roles={["admin", "customer_service"]}>
          <NeedsAttentionPage />
        </ProtectedRoute>
      </Route>

      <Route path="/unmatched-contacts">
        <ProtectedRoute roles={["admin", "customer_service"]}>
          <UnmatchedContactsPage />
        </ProtectedRoute>
      </Route>

      <Route path="/reporting">
        <ProtectedRoute roles={["admin"]}>
          <ReportingPage />
        </ProtectedRoute>
      </Route>

      <Route path="/users">
        <ProtectedRoute roles={["admin"]}>
          <UsersPage />
        </ProtectedRoute>
      </Route>

      <Route>
        <div className="flex min-h-screen items-center justify-center text-sm text-gray-500">Page not found.</div>
      </Route>
    </Switch>
  );
}
