import { create } from 'zustand'
import { Group } from '../types'
import { groupService } from '../services/groups'
import { useAuthStore } from './authStore'
import { debugLog, debugError } from '../utils/debug'
import { firestoreDebugger } from '../utils/firestoreDebugger'
import { getFirebaseErrorMessage } from '../utils/errorHandler'
import { collection, getDocsFromServer } from 'firebase/firestore'
import { db } from '../services/firebase'

interface GroupState {
  groups: Group[]
  loading: boolean
  error: string | null
  unsubscribe: (() => void) | null
  isRealtimeMode: boolean
  
  // Actions
  setGroups: (groups: Group[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setUnsubscribe: (unsubscribe: (() => void) | null) => void
  setRealtimeMode: (isRealtime: boolean) => void
  
  // Group operations
  fetchGroups: () => void
  refreshGroups: () => void
  createGroup: (userId: string, groupData: Omit<Group, 'id' | 'userId' | 'createdAt'>) => Promise<void>
  updateGroup: (userId: string, groupId: string, updates: Partial<Group>) => Promise<void>
  deleteGroup: (userId: string, groupId: string) => Promise<void>
  
  // Computed values
  getGroupById: (groupId: string) => Group | undefined
  getDefaultGroup: () => Group
}

export const useGroupStore = create<GroupState>((set, get) => ({
  groups: [],
  loading: false,
  error: null,
  unsubscribe: null,
  isRealtimeMode: true,
  
  setGroups: (groups) => set({ groups }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setUnsubscribe: (unsubscribe) => set({ unsubscribe }),
  setRealtimeMode: (isRealtime) => set({ isRealtimeMode: isRealtime }),
  
  fetchGroups: () => {
    const { unsubscribe, loading } = get()
    
    // Prevent duplicate calls
    if (loading) {
      debugLog('GroupStore: Already loading, skipping duplicate call')
      return
    }
    
    // Cleanup existing subscription
    if (unsubscribe) {
      unsubscribe()
    }
    
    set({ loading: true, error: null })
    
    // Get current user from auth store
    const authState = useAuthStore.getState()
    const user = authState.user
    
    if (!user) {
      set({ loading: false, error: 'User not authenticated' })
      return
    }
    
    // Add delay and retry mechanism to ensure Firebase Auth is fully synced
    const setupGroupsWithRetry = async (retries = 3) => {
      try {
        // Log auth state before operation
        await firestoreDebugger.logAuthState(`GroupStore-fetchGroups-attempt-${4-retries}`)
        
        // Wait for auth to be fully ready
        const authReady = await firestoreDebugger.waitForAuthReady(2000)
        if (!authReady) {
          throw new Error('Auth timeout - user not ready')
        }
        
        // Log before Firestore operations
        firestoreDebugger.logFirestoreOperation('ensureDefaultGroup-start', user.uid)
        await groupService.ensureDefaultGroup(user.uid)
        firestoreDebugger.logFirestoreOperation('ensureDefaultGroup-success', user.uid)
        
        // Try realtime subscription first, fallback to server read if permission denied
        firestoreDebugger.logFirestoreOperation('subscribeToGroups-start', user.uid)
        try {
          const newUnsubscribe = groupService.subscribeToGroups(user.uid, (groups) => {
            firestoreDebugger.logFirestoreOperation('subscribeToGroups-callback', user.uid)
            set({ groups, loading: false, error: null })
          })
          
          set({ unsubscribe: newUnsubscribe, isRealtimeMode: true })
          firestoreDebugger.logFirestoreOperation('subscribeToGroups-success', user.uid)
        } catch (error: any) {
          // Fallback to server read if subscription fails
          firestoreDebugger.logFirestoreOperation('subscribeToGroups-fallback', user.uid, error)
          
          try {
            const groupsRef = collection(db, 'users', user.uid, 'groups')
            const snapshot = await getDocsFromServer(groupsRef)
            
            const groups = snapshot.docs.map(doc => {
              const data = doc.data()
              return {
                id: doc.id,
                userId: user.uid,
                name: data.name,
                color: data.color,
                icon: data.icon,
                createdAt: data.createdAt?.toDate?.() || new Date(),
              }
            })
            
            set({ groups, loading: false, error: null, isRealtimeMode: false })
            firestoreDebugger.logFirestoreOperation('getGroups-fallback-success', user.uid)
          } catch (fallbackError: any) {
            firestoreDebugger.logFirestoreOperation('getGroups-fallback-error', user.uid, fallbackError)
            set({ loading: false, error: 'Failed to load groups', isRealtimeMode: false })
          }
        }
      } catch (error: any) {
        firestoreDebugger.logFirestoreOperation('fetchGroups-error', user.uid, error)
        debugError('GroupStore: Failed to setup groups', error)
        
        // Retry if permission denied and retries left
        if (error.code === 'permission-denied' && retries > 0) {
          debugLog(`GroupStore: Retrying in 1s... (${retries} retries left)`)
          setTimeout(() => setupGroupsWithRetry(retries - 1), 1000)
          return
        }
        
        set({ loading: false, error: 'Failed to load groups. Please try refreshing the page.' })
      }
    }
    
    setupGroupsWithRetry()
  },

  refreshGroups: () => {
    const authState = useAuthStore.getState()
    const user = authState.user
    
    if (!user) return
    
    set({ loading: true })
    
    // Force server read for refresh
    const refreshData = async () => {
      try {
        const groupsRef = collection(db, 'users', user.uid, 'groups')
        const snapshot = await getDocsFromServer(groupsRef)
        
        const groups = snapshot.docs.map(doc => {
          const data = doc.data()
          return {
            id: doc.id,
            userId: user.uid,
            name: data.name,
            color: data.color,
            icon: data.icon,
            createdAt: data.createdAt?.toDate?.() || new Date(),
          }
        })
        
        set({ groups, loading: false, error: null })
      } catch (error: any) {
        set({ loading: false, error: 'Failed to refresh groups' })
      }
    }
    
    refreshData()
  },
  
  createGroup: async (userId, groupData) => {
    debugLog('GroupStore: Creating group', { userId, groupData })
    set({ loading: true, error: null })
    try {
      const result = await groupService.createGroup(userId, groupData)
      debugLog('GroupStore: Create group result', result)
      
      if (result.error) {
        debugError('GroupStore: Create group failed', result.error)
        set({ error: result.error, loading: false })
        throw new Error(result.error)
      } else {
        debugLog('GroupStore: Group created successfully', result.id)
        set({ loading: false })
      }
    } catch (error: any) {
      debugError('GroupStore: Create group exception', error)
      set({ error: error.message, loading: false })
      throw error
    }
  },
  
  updateGroup: async (userId, groupId, updates) => {
    try {
      const result = await groupService.updateGroup(userId, groupId, updates)
      if (result.error) {
        set({ error: result.error })
      }
    } catch (error: any) {
      const friendlyError = getFirebaseErrorMessage(error)
      set({ error: friendlyError })
    }
  },
  
  deleteGroup: async (userId, groupId) => {
    try {
      const result = await groupService.deleteGroup(userId, groupId)
      if (result.error) {
        set({ error: result.error })
        throw new Error(result.error)
      }
    } catch (error: any) {
      const friendlyError = getFirebaseErrorMessage(error)
      set({ error: friendlyError })
      throw error
    }
  },
  
  getGroupById: (groupId) => {
    const { groups } = get()
    return groups.find(group => group.id === groupId)
  },
  
  getDefaultGroup: () => {
    const { groups } = get()
    return groups.find(group => group.name === 'Default' || group.name === 'Nhóm mặc định') || {
      id: 'default',
      name: 'Default',
      color: '#6B7280',
      icon: '📋',
      userId: '',
      createdAt: new Date(),
    }
  },
}))