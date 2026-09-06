import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';

// ── Core Screens ──
import LoginScreen from '../components/screens/LoginScreen';
import PrincipalDashboard from '../components/screens/PrincipalDashboard';
import TeacherDashboard from '../components/screens/TeacherDashboard';
import FinanceDashboard from '../components/screens/FinanceDashboard';
import ParentDashboard from '../components/screens/ParentDashboard';

// ── Admin Screens ──
import AdminStaffDirectory from '../components/screens/AdminStaffDirectory';
import AdminAcademicsOverview from '../components/screens/AdminAcademicsOverview';
import AdminReportsScreen from '../components/screens/AdminReportsScreen';

// ── Teacher Screens ──
import TeacherAttendanceEntry from '../components/screens/TeacherAttendanceEntry';
import TeacherEnterMarks from '../components/screens/TeacherEnterMarks';
import TeacherLeaveRequests from '../components/screens/TeacherLeaveRequests';
import TeacherTimetableScreen from '../components/screens/TeacherTimetableScreen';
import TeacherProfileScreen from '../components/screens/TeacherProfileScreen';

// ── Finance Screens ──
import FinanceInvoices from '../components/screens/FinanceInvoices';
import FinanceReportsScreen from '../components/screens/FinanceReportsScreen';
import FeeStructuresScreen from '../components/screens/FeeStructuresScreen';
import FeeDefaultersScreen from '../components/screens/FeeDefaultersScreen';

// ── Parent / Student Screens ──
import StudentAttendanceScreen from '../components/screens/StudentAttendanceScreen';
import StudentTimetableScreen from '../components/screens/StudentTimetableScreen';
import StudentFeesScreen from '../components/screens/StudentFeesScreen';
import ParentChildResults from '../components/screens/ParentChildResults';
import StudentProfileScreen from '../components/screens/StudentProfileScreen';

// ── Shared Screens ──
import LibraryScreen from '../components/screens/LibraryScreen';
import TransportScreen from '../components/screens/TransportScreen';
import AnnouncementsScreen from '../components/screens/AnnouncementsScreen';
import PayrollScreen from '../components/screens/PayrollScreen';
import MoreMenu from '../components/screens/MoreMenu';

const RootStack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();
const MoreStack = createNativeStackNavigator();

// ═══════════════════════════════════════════════
// Admin "More" Stack — Library, Transport, Announcements, Payroll
// ═══════════════════════════════════════════════
function AdminMoreStack() {
  return (
    <MoreStack.Navigator screenOptions={{ headerShown: false }}>
      <MoreStack.Screen name="AdminMoreMenu">
        {({ navigation }) => (
          <MoreMenu
            title="More"
            navigation={navigation}
            items={[
              { label: 'Library', icon: '📚', route: 'Library', description: 'Browse & manage books' },
              { label: 'Transport', icon: '🚌', route: 'Transport', description: 'Routes & vehicles' },
              { label: 'Announcements', icon: '📢', route: 'Announcements', description: 'School-wide notices' },
              { label: 'Payroll', icon: '💵', route: 'Payroll', description: 'Staff salary management' },
            ]}
          />
        )}
      </MoreStack.Screen>
      <MoreStack.Screen name="Library" component={LibraryScreen} />
      <MoreStack.Screen name="Transport" component={TransportScreen} />
      <MoreStack.Screen name="Announcements" component={AnnouncementsScreen} />
      <MoreStack.Screen name="Payroll" component={PayrollScreen} />
    </MoreStack.Navigator>
  );
}

// ═══════════════════════════════════════════════
// Teacher "More" Stack — Timetable, Library, Announcements, Profile
// ═══════════════════════════════════════════════
function TeacherMoreStack() {
  return (
    <MoreStack.Navigator screenOptions={{ headerShown: false }}>
      <MoreStack.Screen name="TeacherMoreMenu">
        {({ navigation }) => (
          <MoreMenu
            title="More"
            navigation={navigation}
            items={[
              { label: 'My Timetable', icon: '📅', route: 'TeacherTimetable', description: 'View your class schedule' },
              { label: 'Library', icon: '📚', route: 'Library', description: 'Issued & available books' },
              { label: 'Announcements', icon: '📢', route: 'Announcements', description: 'School notices' },
              { label: 'Profile', icon: '👤', route: 'TeacherProfile', description: 'Your account details' },
            ]}
          />
        )}
      </MoreStack.Screen>
      <MoreStack.Screen name="TeacherTimetable" component={TeacherTimetableScreen} />
      <MoreStack.Screen name="Library" component={LibraryScreen} />
      <MoreStack.Screen name="Announcements" component={AnnouncementsScreen} />
      <MoreStack.Screen name="TeacherProfile" component={TeacherProfileScreen} />
    </MoreStack.Navigator>
  );
}

// ═══════════════════════════════════════════════
// Finance "More" Stack — Fee Structures, Defaulters, Payroll, Announcements
// ═══════════════════════════════════════════════
function FinanceMoreStack() {
  return (
    <MoreStack.Navigator screenOptions={{ headerShown: false }}>
      <MoreStack.Screen name="FinanceMoreMenu">
        {({ navigation }) => (
          <MoreMenu
            title="More"
            navigation={navigation}
            items={[
              { label: 'Fee Structures', icon: '🏗️', route: 'FeeStructures', description: 'Manage fee categories' },
              { label: 'Fee Defaulters', icon: '⚠️', route: 'FeeDefaulters', description: 'Overdue payments' },
              { label: 'Payroll', icon: '💵', route: 'Payroll', description: 'Staff salary management' },
              { label: 'Announcements', icon: '📢', route: 'Announcements', description: 'School notices' },
            ]}
          />
        )}
      </MoreStack.Screen>
      <MoreStack.Screen name="FeeStructures" component={FeeStructuresScreen} />
      <MoreStack.Screen name="FeeDefaulters" component={FeeDefaultersScreen} />
      <MoreStack.Screen name="Payroll" component={PayrollScreen} />
      <MoreStack.Screen name="Announcements" component={AnnouncementsScreen} />
    </MoreStack.Navigator>
  );
}

// ═══════════════════════════════════════════════
// Parent "More" Stack — Library, Transport, Announcements, Profile
// ═══════════════════════════════════════════════
function ParentMoreStack() {
  return (
    <MoreStack.Navigator screenOptions={{ headerShown: false }}>
      <MoreStack.Screen name="ParentMoreMenu">
        {({ navigation }) => (
          <MoreMenu
            title="More"
            navigation={navigation}
            items={[
              { label: 'Results', icon: '📊', route: 'Results', description: 'Exam report cards' },
              { label: 'Library', icon: '📚', route: 'Library', description: 'Issued books' },
              { label: 'Transport', icon: '🚌', route: 'Transport', description: 'Bus routes & tracking' },
              { label: 'Announcements', icon: '📢', route: 'Announcements', description: 'School notices' },
              { label: 'Profile', icon: '👤', route: 'StudentProfile', description: "Child's details" },
            ]}
          />
        )}
      </MoreStack.Screen>
      <MoreStack.Screen name="Results" component={ParentChildResults} />
      <MoreStack.Screen name="Library" component={LibraryScreen} />
      <MoreStack.Screen name="Transport" component={TransportScreen} />
      <MoreStack.Screen name="Announcements" component={AnnouncementsScreen} />
      <MoreStack.Screen name="StudentProfile" component={StudentProfileScreen} />
    </MoreStack.Navigator>
  );
}

// ═══════════════════════════════════════════════
// Tab Navigators for Each Role
// ═══════════════════════════════════════════════

const tabScreenOptions = {
  headerShown: false,
  tabBarActiveTintColor: '#004ac6',
  tabBarInactiveTintColor: '#737686',
  tabBarStyle: {
    backgroundColor: '#f7f8fa',
    borderTopWidth: 0,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    height: 60,
    paddingBottom: 8,
    paddingTop: 4,
  },
  tabBarLabelStyle: {
    fontSize: 11,
    fontWeight: '600' as const,
  },
};

function AdminTabs({ route }: any) {
  const onLogout = route.params?.onLogout;
  return (
    <Tab.Navigator screenOptions={tabScreenOptions}>
      <Tab.Screen
        name="Dashboard"
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🏫</Text> }}
      >
        {() => <PrincipalDashboard onLogout={onLogout} />}
      </Tab.Screen>
      <Tab.Screen
        name="Staff"
        component={AdminStaffDirectory}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>👥</Text> }}
      />
      <Tab.Screen
        name="Academics"
        component={AdminAcademicsOverview}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>📖</Text> }}
      />
      <Tab.Screen
        name="Reports"
        component={AdminReportsScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>📊</Text> }}
      />
      <Tab.Screen
        name="More"
        component={AdminMoreStack}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>⋯</Text> }}
      />
    </Tab.Navigator>
  );
}

function TeacherTabs({ route }: any) {
  const onLogout = route.params?.onLogout;
  return (
    <Tab.Navigator screenOptions={tabScreenOptions}>
      <Tab.Screen
        name="Dashboard"
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🏠</Text> }}
      >
        {() => <TeacherDashboard onLogout={onLogout} />}
      </Tab.Screen>
      <Tab.Screen
        name="Attendance"
        component={TeacherAttendanceEntry}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>✅</Text> }}
      />
      <Tab.Screen
        name="Exams"
        component={TeacherEnterMarks}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>📝</Text> }}
      />
      <Tab.Screen
        name="Leaves"
        component={TeacherLeaveRequests}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🗓️</Text> }}
      />
      <Tab.Screen
        name="More"
        component={TeacherMoreStack}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>⋯</Text> }}
      />
    </Tab.Navigator>
  );
}

function FinanceTabs({ route }: any) {
  const onLogout = route.params?.onLogout;
  return (
    <Tab.Navigator screenOptions={tabScreenOptions}>
      <Tab.Screen
        name="Dashboard"
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>💰</Text> }}
      >
        {() => <FinanceDashboard onLogout={onLogout} />}
      </Tab.Screen>
      <Tab.Screen
        name="Invoices"
        component={FinanceInvoices}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🧾</Text> }}
      />
      <Tab.Screen
        name="Reports"
        component={FinanceReportsScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>📈</Text> }}
      />
      <Tab.Screen
        name="More"
        component={FinanceMoreStack}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>⋯</Text> }}
      />
    </Tab.Navigator>
  );
}

function ParentTabs() {
  return (
    <Tab.Navigator screenOptions={tabScreenOptions}>
      <Tab.Screen
        name="Dashboard"
        component={ParentDashboard}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🏠</Text> }}
      />
      <Tab.Screen
        name="Attendance"
        component={StudentAttendanceScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>✅</Text> }}
      />
      <Tab.Screen
        name="Timetable"
        component={StudentTimetableScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>📅</Text> }}
      />
      <Tab.Screen
        name="Fees"
        component={StudentFeesScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>💳</Text> }}
      />
      <Tab.Screen
        name="More"
        component={ParentMoreStack}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>⋯</Text> }}
      />
    </Tab.Navigator>
  );
}

// ═══════════════════════════════════════════════
// Root App Navigator
// ═══════════════════════════════════════════════

export default function AppNavigator() {
  return (
    <NavigationContainer>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        <RootStack.Screen name="Login" component={LoginScreenWrapper} />
        <RootStack.Screen name="AdminApp" component={AdminTabs} />
        <RootStack.Screen name="TeacherApp" component={TeacherTabs} />
        <RootStack.Screen name="FinanceApp" component={FinanceTabs} />
        <RootStack.Screen name="ParentApp" component={ParentTabs} />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

function LoginScreenWrapper({ navigation }: any) {
  const handleLogin = (role: string) => {
    if (role === 'principal') navigation.replace('AdminApp', { onLogout: () => navigation.replace('Login') });
    else if (role === 'teacher') navigation.replace('TeacherApp', { onLogout: () => navigation.replace('Login') });
    else if (role === 'finance') navigation.replace('FinanceApp', { onLogout: () => navigation.replace('Login') });
    else if (role === 'parent') navigation.replace('ParentApp', { onLogout: () => navigation.replace('Login') });
  };

  return <LoginScreen onLogin={handleLogin} />;
}
