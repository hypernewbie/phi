" Phi Fog Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_fog"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#cbd5e1 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#cbd5e1
hi IncSearch        guifg=#14141a guibg=#94a3b8
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#cbd5e1 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#cbd5e1 guibg=#1f1f26  gui=bold
hi Directory        guifg=#94a3b8

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#cbd5e1
hi String           guifg=#e2e8f0
hi Character        guifg=#e2e8f0
hi Number           guifg=#cbd5e1
hi Boolean          guifg=#cbd5e1
hi Float            guifg=#cbd5e1

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#94a3b8

hi Statement        guifg=#cbd5e1 gui=bold
hi Conditional      guifg=#cbd5e1 gui=bold
hi Repeat           guifg=#cbd5e1 gui=bold
hi Label            guifg=#cbd5e1
hi Operator         guifg=#94a3b8
hi Keyword          guifg=#cbd5e1 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#64748b
hi Include          guifg=#64748b
hi Define           guifg=#64748b
hi Macro            guifg=#64748b
hi PreCondit        guifg=#64748b

hi Type             guifg=#64748b gui=bold
hi StorageClass     guifg=#64748b
hi Structure        guifg=#64748b
hi Typedef          guifg=#64748b

hi Special          guifg=#cbd5e1
hi SpecialChar      guifg=#e2e8f0
hi Tag              guifg=#94a3b8
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#94a3b8    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#cbd5e1  guibg=#1f1f26  gui=bold
