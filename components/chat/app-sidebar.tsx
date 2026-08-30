"use client";

import { PanelLeftIcon, PenSquareIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { User } from "next-auth";
import { useCallback } from "react";
import { BrandMark } from "@/components/brand/brand-mark";
import { SidebarHistory } from "@/components/chat/sidebar-history";
import { SidebarUserNav } from "@/components/chat/sidebar-user-nav";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export function AppSidebar({ user }: { user: User | undefined }) {
  const router = useRouter();
  const { setOpenMobile, toggleSidebar } = useSidebar();

  const closeMobile = useCallback(() => {
    setOpenMobile(false);
  }, [setOpenMobile]);

  const handleToggleSidebar = useCallback(() => {
    toggleSidebar();
  }, [toggleSidebar]);

  const handleNewChat = useCallback(() => {
    setOpenMobile(false);
    router.push("/");
  }, [router, setOpenMobile]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="pb-0 pt-3">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-row items-center justify-between">
            <div className="group/logo relative flex items-center justify-center">
              <SidebarMenuButton
                asChild
                className="size-8 !px-0 items-center justify-center group-data-[collapsible=icon]:group-hover/logo:opacity-0"
                tooltip="OpenCoven"
              >
                <Link href="/" onClick={closeMobile}>
                  <BrandMark className="size-4 text-[var(--oc-accent)]" />
                </Link>
              </SidebarMenuButton>
              <Tooltip>
                <TooltipTrigger asChild>
                  <SidebarMenuButton
                    className="pointer-events-none absolute inset-0 size-8 opacity-0 group-data-[collapsible=icon]:pointer-events-auto group-data-[collapsible=icon]:group-hover/logo:opacity-100"
                    onClick={handleToggleSidebar}
                  >
                    <PanelLeftIcon className="size-4" />
                  </SidebarMenuButton>
                </TooltipTrigger>
                <TooltipContent className="hidden md:block" side="right">
                  Open sidebar
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex flex-1 items-baseline gap-2 pl-1 group-data-[collapsible=icon]:hidden">
              <span className="font-medium text-[13px] tracking-[-0.01em]">
                OpenCoven
              </span>
              <span className="text-[10px] text-sidebar-foreground/45 uppercase tracking-[0.14em]">
                Agents
              </span>
            </div>
            <div className="group-data-[collapsible=icon]:hidden">
              <SidebarTrigger className="text-sidebar-foreground/60 transition-colors duration-150 hover:text-sidebar-foreground" />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pt-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="h-8 rounded-[8px] border border-[var(--oc-accent-line)] bg-[var(--oc-accent-soft)] font-medium text-[13px] text-[var(--oc-accent)] transition-colors duration-150 hover:bg-[var(--oc-accent-soft)] hover:text-[var(--oc-accent)]"
                  onClick={handleNewChat}
                  tooltip="New Chat"
                >
                  <PenSquareIcon className="size-4" />
                  <span className="font-medium">New chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarHistory user={user} />
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border pt-2 pb-3">
        {user ? <SidebarUserNav user={user} /> : null}
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
