" Phi Mint Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_mint"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#7bed9f gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#7bed9f
hi IncSearch        guifg=#14141a guibg=#2ed573
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#7bed9f guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#7bed9f guibg=#1f1f26  gui=bold
hi Directory        guifg=#2ed573

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#7bed9f
hi String           guifg=#b8f5cd
hi Character        guifg=#b8f5cd
hi Number           guifg=#7bed9f
hi Boolean          guifg=#7bed9f
hi Float            guifg=#7bed9f

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#2ed573

hi Statement        guifg=#7bed9f gui=bold
hi Conditional      guifg=#7bed9f gui=bold
hi Repeat           guifg=#7bed9f gui=bold
hi Label            guifg=#7bed9f
hi Operator         guifg=#2ed573
hi Keyword          guifg=#7bed9f gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#1e8449
hi Include          guifg=#1e8449
hi Define           guifg=#1e8449
hi Macro            guifg=#1e8449
hi PreCondit        guifg=#1e8449

hi Type             guifg=#1e8449 gui=bold
hi StorageClass     guifg=#1e8449
hi Structure        guifg=#1e8449
hi Typedef          guifg=#1e8449

hi Special          guifg=#7bed9f
hi SpecialChar      guifg=#b8f5cd
hi Tag              guifg=#2ed573
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#2ed573    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#7bed9f  guibg=#1f1f26  gui=bold
